// Common LaTeX packages that busytex's bundled TeX Live subset omits (the
// algorithms / algorithmicx family, multirow, bbm). We vendor their .sty under
// assets/fallback-styles and inject them at compile time when the project
// doesn't already ship its own copy — so real papers using these still render
// without a self-hosted package server. Font-based packages (e.g. bbm) can't be
// covered this way and remain unsupported.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, posix } from 'node:path';
import type { EngineFile } from './browserHost.js';

const DIR = fileURLToPath(new URL('../../assets/fallback-styles', import.meta.url));

let cache: EngineFile[] | null = null;

export async function getFallbackStyles(): Promise<EngineFile[]> {
  if (cache) return cache;
  try {
    // .cls too: a missing document class is fatal in a way a missing package
    // isn't — it can't be stubbed out — so vendoring one here is the only way
    // a paper using it compiles on the bundled TeX Live.
    const names = (await readdir(DIR)).filter((n) => n.endsWith('.sty') || n.endsWith('.cls'));
    cache = await Promise.all(
      names.map(async (n) => ({ path: n, content: await readFile(join(DIR, n), 'utf8'), encoding: 'utf8' as const })),
    );
  } catch {
    cache = [];
  }
  return cache;
}

/**
 * The fallbacks a compile of `mainRel` needs, placed next to it. busytex runs
 * TeX from the main file's directory with no TEXINPUTS, so a .sty at the project
 * root — ours or the project's own — is invisible to a document in a
 * subdirectory. Only a copy the project ships in that same directory counts as
 * already present; it always wins over ours.
 */
export function placeFallbacks(fallbacks: EngineFile[], files: EngineFile[], mainRel: string): EngineFile[] {
  const mainDir = posix.dirname(mainRel);
  const present = new Set(files.filter((f) => posix.dirname(f.path) === mainDir).map((f) => posix.basename(f.path)));
  return fallbacks
    .filter((f) => !present.has(f.path))
    .map((f) => ({ ...f, path: posix.join(mainDir, f.path) }));
}
