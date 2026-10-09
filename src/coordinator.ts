// Single compile path shared by the render_preview tool (active) and the file
// watcher (passive). All compiles are serialized through one promise chain so a
// watcher-triggered compile and a tool-triggered compile never run at once, and
// each compile always reads the latest files off disk.
import { compileProject, type CompileProjectResult, type Engine, type Backend } from './project/compileProject.js';
import { getPreview } from './engine/browserHost.js';
import { createCheckpoint } from './git/checkpoints.js';
import { setProjectRoot } from './session.js';
import { scheduleReanchor, setLatestPdfText } from './preview/pdfPages.js';

interface Config {
  projectRoot: string;
  mainFile?: string;
  engine?: Engine;
  backend?: Backend;
  /** Passed through to the system backend. Sticky across watcher-triggered
   *  recompiles, so a file save doesn't silently drop back to a build the
   *  document can't complete. */
  shellEscape?: boolean;
}

let config: Config | null = null;
let chain: Promise<CompileProjectResult | null> = Promise.resolve(null);

export function setConfig(next: Config): void {
  config = next;
  setProjectRoot(next.projectRoot); // keep the git endpoints reading the same repo
}

// Whether the PDF currently on screen came from an error-free run. Guards a
// good preview against being replaced by a truncated one (see doCompile).
let lastPublishWasClean = false;

async function doCompile(): Promise<CompileProjectResult> {
  if (!config) throw new Error('No project configured yet — call render_preview first.');
  const preview = await getPreview();
  preview.broadcast({ type: 'compiling' });
  const result = await compileProject(config);
  const clean = result.success && (!result.verdict || result.verdict.errors.length === 0);

  if (result.success && result.pdf) {
    // LaTeX often "recovers" from an error and still emits a PDF — just a
    // truncated one, missing every page after the failure. Publishing that over
    // a render that worked is how an author loses a 13-page preview to one
    // stale \usepackage. So a run with errors never overwrites a clean render:
    // the good pages stay on screen and the error panel explains why.
    //
    // With nothing better to show (the last render was itself broken, or this
    // is the first compile), publish anyway — a partial PDF beats a blank pane,
    // which is also what Overleaf does.
    if (clean || !lastPublishWasClean) {
      // Snapshot BEFORE notifying viewers, so a viewer that refreshes its
      // history on the reload event already sees this checkpoint.
      // createCheckpoint swallows its own errors and no-ops outside a git repo.
      //
      // Only clean runs earn a checkpoint: History exists so you can return to
      // a state that worked, and snapshotting source that compiles with errors
      // would dilute exactly that promise.
      if (clean) await createCheckpoint(config.projectRoot);
      preview.setLatestPdf(result.pdf, result.mainFile);
      lastPublishWasClean = clean;
      // Pages may have been added or removed: move each comment to wherever
      // its quote is now. Only from a clean render — a truncated one would
      // send comments to the wrong pages and wipe their boxes. Not awaited, so
      // the next compile doesn't wait on pdf.js; check_comments does instead.
      if (clean) {
        setLatestPdfText(result.pdf);
        scheduleReanchor(config.projectRoot, () => preview.broadcast({ type: 'comments-changed', quiet: true }));
      }
    }
    if (!clean) {
      preview.broadcast({ type: 'compile-error', log: (result.log || '').slice(-1800) });
    }
  } else {
    preview.broadcast({ type: 'compile-error', log: (result.log || result.error || 'compile failed').slice(-1800) });
  }
  return result;
}

/** Enqueue a compile; resolves with its result. Serialized against all others. */
export function requestCompile(): Promise<CompileProjectResult> {
  const next = chain.then(() => doCompile());
  // Keep the chain alive even if this compile rejects.
  chain = next.then(
    (r) => r,
    () => null,
  );
  return next;
}
