// The text of each page of the PDF on screen, and keeping comments on it.
//
// The coordinator hands every clean PDF to setLatestPdfText; the text is
// extracted lazily (pdf.js, ~4 ms a page) and only when something asks — the
// re-anchoring after a compile, which does so only when there are comments,
// and check_comments, to tell a comment's source location apart by its page.
import { listComments, reanchorComments } from './commentsStore.js';
import { anchorUpdate, foldPages } from './reanchor.js';

let latest: { pdf: Uint8Array; pages?: Promise<string[] | null> } | null = null;

/** Remember the PDF now on screen. Copied: the caller keeps its buffer. */
export function setLatestPdfText(pdf: Uint8Array): void {
  latest = { pdf: new Uint8Array(pdf) };
}

async function extract(pdf: Uint8Array): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // verbosity 0: pdf.js prints its warnings with console.log, and stdout is the
  // MCP channel.
  const task = pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      // Joined with nothing, as the workspace joins its text-layer spans, so
      // folded offsets agree on both sides.
      pages.push(content.items.map((it) => ('str' in it ? it.str : '')).join(''));
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

/** Raw text of each page of the latest PDF (index 0 is page 1), or null if there is none. */
export function latestPageTexts(): Promise<string[] | null> {
  if (!latest) return Promise.resolve(null);
  latest.pages ??= extract(latest.pdf).catch(() => null);
  return latest.pages;
}

/**
 * Move every comment to where its passage is now. Resolved ones too: their
 * green highlight is what the author reviews, and addressing a comment is
 * exactly what rewrites its text. Resolves to whether any comment changed, so
 * the caller knows to tell the workspace.
 */
export async function reanchorToLatest(root: string): Promise<boolean> {
  // A cheap read first: with no comment at all, the PDF is never parsed.
  if (!(await listComments(root)).length) return false;
  const pages = await latestPageTexts();
  if (!pages) return false;
  const folded = foldPages(pages);
  // No extractable text (Type3 bitmap fonts, fonts without a ToUnicode map):
  // that says nothing about where any passage went.
  if (!folded.some((t) => t.length)) return false;
  return reanchorComments(root, (c) => anchorUpdate(folded, pages, c));
}

// Re-anchorings run one at a time, off the compile chain: a compile publishes
// its PDF without waiting for pdf.js to read every page, and readers of the
// comments wait for the latest pass instead (settleComments).
let pending: Promise<unknown> = Promise.resolve();

/** Queue a re-anchoring; `onChange` runs if it moved any comment. */
export function scheduleReanchor(root: string, onChange: () => void): void {
  pending = pending.then(() => reanchorToLatest(root)).then((changed) => { if (changed) onChange(); }, () => {});
}

/** Resolves once every queued re-anchoring has finished. */
export function settleComments(): Promise<void> {
  return pending.then(() => {}, () => {});
}
