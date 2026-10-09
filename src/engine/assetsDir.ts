// Where the ~650 MB WASM TeX Live lives.
//
// It used to live inside the package directory, which is wrong for the
// documented install: `npx -y magictex-mcp` resolves into npm's `_npx` cache,
// and npm replaces that entry wholesale on upgrade — taking the assets with it.
// Every release cost users a fresh 480 MB download of bytes that hadn't changed.
//
// A per-user cache survives upgrades, and is shared between an npx run, a global
// install and a checkout instead of each keeping its own copy.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const IN_PACKAGE = join(PKG_ROOT, 'assets', 'busytex');

/** The marker we treat as "the assets are really here", not just an empty dir. */
const MARKER = 'busytex.wasm';

/** Per-user cache root for what MagicTeX keeps outside a project — now just the
 *  WASM engine, which is shared and re-downloadable. Checkpoint history used to
 *  live here too, keyed by a hash of the project path; it moved into the project
 *  so that it follows the paper rather than the path, and so that deleting a
 *  paper deletes its drafts. `historyRepo.ts` still reads the old location once,
 *  to bring existing timelines forward. */
export function cacheRoot(): string {
  const home = homedir();
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'magictex');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Caches', 'magictex');
  }
  return join(process.env.XDG_CACHE_HOME || join(home, '.cache'), 'magictex');
}

function userCache(): string {
  return join(cacheRoot(), 'busytex');
}

/**
 * Directory holding the busytex WASM assets. Resolution order:
 *
 *  1. `MAGICTEX_ASSETS_DIR` — an explicit choice always wins.
 *  2. An existing in-package copy. A checkout that already downloaded them, and
 *     anyone upgrading from <= 0.1.4, keeps working untouched — nobody should
 *     re-download 480 MB because we changed where new installs put things.
 *  3. The per-user cache, for installs that don't have them yet.
 */
export function busytexDir(): string {
  const override = process.env.MAGICTEX_ASSETS_DIR;
  if (override) return override;
  if (existsSync(join(IN_PACKAGE, MARKER))) return IN_PACKAGE;
  return userCache();
}

/** The parent passed to `texlyre-busytex download-assets`, which creates a
 *  `busytex/` subdirectory inside whatever destination it is given. */
export function busytexDownloadDest(): string {
  return dirname(busytexDir());
}

/** True once the assets are actually present, not merely expected. */
export function busytexPresent(): boolean {
  return existsSync(join(busytexDir(), MARKER));
}

/** Which texlyre-busytex release the assets were downloaded for. Present is not
 *  the same as current: the engine's JS ships in node_modules and moves with
 *  every upgrade, but the assets sit in a cache that outlives it. 1.4.0's runner
 *  loads busytex_biber.js at init, so a cache fetched for 1.2.x — busytex.wasm
 *  and all — fails to start. The stamp is how we notice. */
export const STAMP = '.magictex-busytex-version';

/** The version the stamp records, or null for assets that predate stamping (or
 *  were downloaded by hand). */
export function busytexStampedVersion(): string | null {
  try {
    return readFileSync(join(busytexDir(), STAMP), 'utf8').trim() || null;
  } catch {
    return null;
  }
}
