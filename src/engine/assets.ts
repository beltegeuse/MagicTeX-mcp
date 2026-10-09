// The TeX Live WASM assets (~520MB download, ~670MB on disk) are NOT committed to
// git — they're fetched once on first run into a per-user cache (see assetsDir.ts
// for why not into the package directory). Progress streams to stderr (stdout is
// the MCP JSON-RPC channel and must stay clean).
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { STAMP, busytexDir, busytexDownloadDest, busytexPresent, busytexStampedVersion } from './assetsDir.js';

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
  if (!rel) throw new Error(`texlyre-busytex declares no CLI entry point. Run manually: npx texlyre-busytex download-assets "${dest}"`);
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
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    child.on('error', reject);
  });
}

/** What to do by hand if the automatic download fails. The stamp line matters:
 *  without it the next start takes the hand-made copy for a stale one. */
function manualHint(version: string): string {
  const dest = busytexDownloadDest();
  return `Run manually: npx texlyre-busytex@${version} download-assets "${dest}" and then write ${version} into ${join(busytexDir(), STAMP)}`;
}

/**
 * Makes sure the WASM assets exist AND match the installed engine.
 *
 * The download never goes into the live directory. texlyre-busytex's downloader
 * does nothing at all when `busytex/` is non-empty, so a stale copy can't be
 * refreshed in place — and fetching next to it means a failed or interrupted
 * download leaves the old, working-for-some-version assets exactly as they were.
 * Only a complete download is swapped in.
 *
 * `download` is injectable so tests can exercise the swap without 500 MB.
 */
export async function ensureAssets(download: (dest: string) => Promise<void> = runDownloader): Promise<void> {
  const version = busytexPackageVersion();
  const present = busytexPresent();
  if (present && busytexStampedVersion() === version) return;

  const dir = busytexDir();
  const parent = dirname(dir);
  await mkdir(parent, { recursive: true });

  if (present) {
    const was = busytexStampedVersion();
    console.error(`[magictex-mcp] TeX engine is now texlyre-busytex ${version}${was ? ` (assets are for ${was})` : ''}: refreshing the WASM TeX Live assets in ${dir} (~520 MB, one time). This can take a few minutes…`);
  } else {
    console.error(`[magictex-mcp] First run: downloading TeX Live WASM assets (~520 MB, one time) into ${dir}. This can take a few minutes…`);
  }

  const staging = join(parent, `.busytex-download-${process.pid}`);
  const old = `${dir}.old-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
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
    await writeFile(join(fetched, STAMP), `${version}\n`);
    if (existsSync(dir)) await rename(dir, old);
    try {
      await rename(fetched, dir);
    } catch (err) {
      if (existsSync(old)) await rename(old, dir);
      throw err;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  await rm(old, { recursive: true, force: true });
  console.error('[magictex-mcp] Assets ready.');
}
