// The text of each page of the PDF on screen, and keeping comments on it.
//
// The coordinator hands every published PDF to setLatestPdfText; the text is
// extracted lazily (pdf.js, ~4 ms a page) and only when something asks — the
// re-anchoring after a compile, which does so only when there are comments,
// and check_comments, to tell a comment's source location apart by its page.
import { listComments, reanchorComments, type AnchorUpdate } from './commentsStore.js';
import { fold } from './textMatch.js';
import { contextAt, foldPages, placeQuote } from './reanchor.js';

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
 * Move every comment to the page its quote is on now. Resolves to whether any
 * comment changed, so the caller knows to tell the workspace.
 */
export async function reanchorToLatest(root: string): Promise<boolean> {
  if (!(await listComments(root)).length) return false;
  const pages = await latestPageTexts();
  if (!pages?.length) return false;
  const folded = foldPages(pages);
  return reanchorComments(root, (c): AnchorUpdate | null => {
    const p = placeQuote(folded, c);
    if (!p) return fold(c.quote).text.length < 4 ? null : { stale: true };
    const u: AnchorUpdate = { page: p.page, stale: false };
    // The stored boxes belong to the old page; the workspace re-finds the text.
    if (p.page !== c.page) u.rects = [];
    // A comment without context gets it once its page is certain: it did not
    // move, or it never had a position of its own (an agent's comment).
    if (c.prefix === undefined && c.suffix === undefined && (p.page === c.page || !c.rects.length)) {
      Object.assign(u, contextAt(pages[p.page - 1], p));
    }
    return u;
  });
}
