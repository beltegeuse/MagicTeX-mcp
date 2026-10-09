// The TeX Live WASM assets (~520MB download, ~670MB on disk) are NOT committed to
// git — they're fetched once on first run into a per-user cache (see assetsDir.ts
// for why not into the package directory). Progress streams to stderr (stdout is
// the MCP JSON-RPC channel and must stay clean).
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { STAMP, busytexDir, busytexPresent, busytexStampedVersion } from './assetsDir.js';

const requireFrom = createRequire(import.meta.url);

/**
 * How to launch the downloader.
 *
 * It used to be `spawn('npx', [...], { shell: process.platform === 'win32' })`,
 * to reach `npx.cmd`. But with `shell: true` Node does not pass an argv — it
 * joins the arguments with spaces into one command line and hands that to the
 * shell, without quoting any of them. The destination is
 * `%LOCALAPPDATA%\magictex`, so for anyone whose Windows account name has a
 * space in it the child saw:
 *
 *   ["download-assets", "C:\\Users\\Zoe", "Lin\\AppData\\Local\\magictex"]
 *
 * and the 480 MB first-run download went to `C:\Users\Zoe` — or failed. Every
 * such user hit it on their very first compile, which is the worst possible
 * moment for the tool to look broken.
 *
 * Quoting the path would work; not needing a shell works better. The package is
 * a dependency of this one, so its CLI is a file on disk we can run with the
 * node we are already running — no shell, no quoting rules, no PATH lookup, and
 * no npx reaching for the network to fetch something already installed.
 *
 * Exported so a test can check what would be launched without spending 480 MB.
 */
export function downloadCommand(dest: string): { command: string; args: string[] } {
  const pkgPath = requireFrom.resolve('texlyre-busytex/package.json');
  const bin = (requireFrom(pkgPath) as { bin?: string | Record<string, string> }).bin;
  // Read from `bin` rather than hardcoding the path: it is the package's own
  // statement of where its entry point is, and it costs nothing to believe it.
  const rel = typeof bin === 'string' ? bin : bin?.['texlyre-busytex'];
  // No manual-download hint here: ensureAssets adds the one that matches the
  // installed version and the actual asset dir.
  if (!rel) throw new Error('texlyre-busytex declares no CLI entry point');
  return { command: process.execPath, args: [join(dirname(pkgPath), rel), 'download-assets', dest] };
}

/** The texlyre-busytex version installed alongside us — what the assets must match. */
export function busytexPackageVersion(): string {
  return (requireFrom(requireFrom.resolve('texlyre-busytex/package.json')) as { version: string }).version;
}

/** Runs the package's own downloader into `dest` (it creates `dest/busytex`).
 *  Its stdout goes to OUR stderr, not our stdout: the downloader prints its
 *  progress with console.log, and our stdout is the MCP JSON-RPC channel — a
 *  progress bar there is a corrupt message to the client. */
export const DOWNLOADER_STDIO = ['ignore', 2, 2] as const;

function runDownloader(dest: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const { command, args } = downloadCommand(dest);
    const child = spawn(command, args, { stdio: [...DOWNLOADER_STDIO] });
    child.on('exit', (code, signal) => (code === 0 ? resolve() : reject(new Error(signal ? `killed by ${signal}` : `exit ${code}`))));
    child.on('error', reject);
  });
}

/** Every asset texlyre-busytex 1.4's BusyTexRunner.initialize() loads (see its
 *  dist/core/busytex-runner.js), plus the package set hostPage.ts preloads. A
 *  copy missing any of them cannot start the engine — a 1.2.x-era cache lacks
 *  the biber files — and one that has them all can. */
export const INIT_FILES = [
  'busytex.js', 'busytex.wasm', 'busytex_worker.js', 'busytex_pipeline.js',
  'busytex_biber.js', 'biber.js', 'biber.wasm', 'biber.data',
  'texlive-basic.js', 'texlive-basic.data',
];

function hasInitFiles(dir: string): boolean {
  return INIT_FILES.every((f) => existsSync(join(dir, f)));
}

/** What to do by hand if the automatic download fails. The downloader always
 *  writes `<dest>/busytex`, so for a MAGICTEX_ASSETS_DIR named anything else the
 *  result has to be moved into place. No stamp step: unstamped assets that have
 *  every INIT_FILE are adopted as they are. */
function manualHint(version: string): string {
  const dir = busytexDir();
  const cmd = `npx texlyre-busytex@${version} download-assets`;
  return basename(dir) === 'busytex'
    ? `Run manually: ${cmd} "${dirname(dir)}"`
    : `Run manually: ${cmd} <some empty dir>, then move <some empty dir>/busytex to "${dir}"`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Removes staging and backup dirs that a killed refresh left behind. They are
 *  named by pid, so a later run would otherwise never look at them — and each
 *  one can be over a gigabyte. Only dead (or our own) pids: a live one is
 *  another session's refresh in progress. */
async function sweepLeftovers(parent: string, base: string): Promise<void> {
  const pattern = new RegExp(`^(?:\\.busytex-download|${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.old)-(\\d+)$`);
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(name.match(pattern)?.[1]);
    if (pid && (pid === process.pid || !pidAlive(pid))) await rm(join(parent, name), { recursive: true, force: true });
  }
}

const isCurrent = (version: string) => busytexPresent() && busytexStampedVersion() === version;

/**
 * Makes sure the WASM assets exist AND match the installed engine.
 *
 * Unstamped assets — from before stamping, or pre-fetched by hand as the README
 * describes — are adopted if they have every file the engine loads at init.
 * Replacing a working copy would cost 520 MB, and break a machine that is
 * offline or cannot reach GitHub.
 *
 * The download never goes into the live directory. texlyre-busytex's downloader
 * does nothing at all when `busytex/` is non-empty, so a stale copy can't be
 * refreshed in place — and fetching next to it means a failed or interrupted
 * download leaves the old assets exactly as they were. Only a complete download
 * is swapped in.
 *
 * Several sessions share the per-user cache and nothing serializes them, so two
 * can refresh at once. Each downloads into its own staging dir; whichever swaps
 * second finds the current version already in place and keeps it.
 *
 * `download` is injectable so tests can exercise the swap without 500 MB.
 */
export async function ensureAssets(download: (dest: string) => Promise<void> = runDownloader): Promise<void> {
  const version = busytexPackageVersion();
  if (isCurrent(version)) return;

  const dir = busytexDir();
  const parent = dirname(dir);
  const present = busytexPresent();
  const was = busytexStampedVersion();
  if (present && was === null && hasInitFiles(dir)) {
    // Stamping is a convenience; a read-only dir still works without it.
    await writeFile(join(dir, STAMP), `${version}\n`).catch(() => {});
    return;
  }

  await mkdir(parent, { recursive: true });
  await sweepLeftovers(parent, basename(dir));

  if (present) {
    console.error(`[magictex-mcp] TeX engine is now texlyre-busytex ${version}${was ? ` (assets are for ${was})` : ''}: refreshing the WASM TeX Live assets in ${dir} (~520 MB, one time). This can take a few minutes…`);
  } else {
    console.error(`[magictex-mcp] First run: downloading TeX Live WASM assets (~520 MB, one time) into ${dir}. This can take a few minutes…`);
  }

  const staging = join(parent, `.busytex-download-${process.pid}`);
  const old = `${dir}.old-${process.pid}`;
  try {
    try {
      await download(staging);
    } catch (err) {
      throw new Error(`asset download failed (${(err as Error).message}). ${manualHint(version)}`);
    }
    const fetched = join(staging, 'busytex');
    if (!existsSync(join(fetched, 'busytex.wasm'))) {
      throw new Error(`Assets download finished but busytex.wasm is missing from it. ${manualHint(version)}`);
    }
    if (!isCurrent(version)) {
      await writeFile(join(fetched, STAMP), `${version}\n`);
      // ENOENT: another session moved the old dir out from under us first.
      await rename(dir, old).catch((err) => { if (err.code !== 'ENOENT') throw err; });
      try {
        await rename(fetched, dir);
      } catch (err) {
        // Lost the race to a session that swapped in the same version: fine.
        if (!isCurrent(version)) {
          if (existsSync(old) && !existsSync(dir)) await rename(old, dir).catch(() => {});
          throw err;
        }
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(old, { recursive: true, force: true });
  }
  console.error('[magictex-mcp] Assets ready.');
}
