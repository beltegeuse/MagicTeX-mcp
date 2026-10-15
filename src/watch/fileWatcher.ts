// Passive live-reload: watch the project's source files and recompile on save,
// so the preview stays live even between explicit render_preview calls (manual
// edits, or several Claude Edit calls before it invokes the tool). Debounced so
// a burst of edits from one turn collapses into a single compile.
//
// chokidar v4 note: glob patterns are NOT supported (v4 removed them — passing
// globs silently watches nothing). So we watch the project directory itself and
// filter events by extension in the handler.
import chokidar, { type FSWatcher } from 'chokidar';
import { basename } from 'node:path';
import { requestCompile } from '../coordinator.js';

const WATCH_EXT = /\.(tex|bib|cls|sty|bst|cfg|clo|def|ldf|fd|bbx|cbx|lbx|png|jpe?g|pdf|eps|svg)$/i;
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.latex-preview', '.vscode', '__pycache__']);
const DEBOUNCE_MS = 400;

let watcher: FSWatcher | null = null;
let timer: NodeJS.Timeout | null = null;
// Why live reload stopped, when it did. Set once, and never retried: the walk
// that failed would fail again on the next render_preview.
let watchFailure: string | null = null;

/** Why live reload is off, or null while it works. */
export function watchFailureReason(): string | null {
  return watchFailure;
}

/**
 * Explain a watcher error to someone who did not know a watcher existed.
 * chokidar watches every directory under the project root, which is the
 * directory Claude Code was started in — not the folder of the .tex file. Started
 * from the root of a large repository (build trees, submodules, vendored code),
 * that is thousands of watches, and the error reaches nobody: an unhandled
 * 'error' event killed the server, which Claude Code only reported as
 * "Connection closed".
 */
export function describeWatchError(err: unknown, projectRoot: string): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const raw = err instanceof Error ? err.message : String(err);
  if (code === 'EMFILE' || code === 'ENFILE' || code === 'ENOSPC') {
    return `the project root ${projectRoot} holds too many files to watch (${code}: ${raw}). `
      + 'MagicTeX watches every folder under the directory Claude Code was started in. '
      + 'Start Claude Code from the folder that holds the LaTeX sources instead.';
  }
  return `watching ${projectRoot} failed (${code ? `${code}: ` : ''}${raw}).`;
}

// Paths the server just wrote itself (built-in editor saves). We skip the change
// event they cause so an in-app save can choose whether to recompile — external
// editors and Claude's own edits are NOT suppressed and still auto-recompile.
const suppressed = new Map<string, number>();
const normPath = (p: string) => p.replace(/\\/g, '/').toLowerCase();

/** Ignore the next watcher event for `absPath` (call right before writing it). */
export function suppressNextChange(absPath: string): void {
  suppressed.set(normPath(absPath), Date.now());
}

/** Start watching `projectRoot` (idempotent — only the first call takes effect). */
export function startWatching(projectRoot: string): void {
  if (watcher || watchFailure) return;
  watcher = chokidar.watch(projectRoot, {
    // Function form (v4-safe): prune ignored directories from the walk entirely.
    ignored: (path, stats) => {
      const name = basename(path);
      if (stats?.isDirectory() || !/\./.test(name)) return IGNORED_DIRS.has(name) || (name.startsWith('.') && name !== '.');
      return false; // files are filtered by extension in the event handler
    },
    ignoreInitial: true, // the tool's own first compile covers the initial state
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });
  const onChange = (path: string) => {
    if (!WATCH_EXT.test(path)) return;
    // Skip a change we caused ourselves via the built-in editor's save endpoint.
    const ts = suppressed.get(normPath(path));
    if (ts !== undefined) {
      suppressed.delete(normPath(path));
      if (Date.now() - ts < 3000) return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      // Fire-and-forget: the watcher just refreshes the viewer; errors already
      // get pushed to the viewer by the coordinator.
      requestCompile().catch(() => {});
    }, DEBOUNCE_MS);
  };
  watcher.on('add', onChange).on('change', onChange).on('unlink', onChange);
  // Without a listener, an 'error' event is thrown and takes the whole server
  // down. Live reload is a convenience: lose it, keep render_preview, and close
  // the watcher so the handles it holds do not starve the compile as well.
  watcher.on('error', (err) => {
    if (watchFailure) return; // a failing walk reports once per directory
    watchFailure = describeWatchError(err, projectRoot);
    console.error(`[magictex-mcp] live reload is off: ${watchFailure}`);
    const failed = watcher;
    watcher = null;
    if (timer) clearTimeout(timer);
    timer = null;
    failed?.close().catch(() => {});
  });
}

export async function stopWatching(): Promise<void> {
  // `timer` is nulled too. Leaving a stale Timeout behind meant a later
  // startWatching() in the same process began with a non-null handle and would
  // clearTimeout something already fired.
  if (timer) clearTimeout(timer);
  timer = null;
  suppressed.clear();
  watchFailure = null;
  await watcher?.close();
  watcher = null;
}
