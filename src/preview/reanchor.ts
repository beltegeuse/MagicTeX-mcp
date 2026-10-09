// Which page of a freshly compiled PDF a comment now belongs on.
//
// A comment used to be pinned to the page number it was made on. Insert a page
// before it — one \pause in a beamer deck is enough — and it silently moved to
// whatever slide took that number: check_comments sent the agent to the wrong
// slide and the workspace painted the highlight over unrelated text. The page
// number is now only a cache; the anchor is the quoted text plus a little of
// what surrounds it on the page (a W3C TextQuoteSelector), re-found after every
// compile.
//
// Pure (no Node or DOM APIs) so the choice can be tested on synthetic pages.
import { fold, findInFolded, commonPrefixLength, commonSuffixLength } from './textMatch.js';

/** What a comment remembers of where it was made. */
export interface QuoteAnchor {
  page: number;
  quote: string;
  /** Page text just before the quote, as it was when the comment was made. */
  prefix?: string;
  /** Page text just after the quote. */
  suffix?: string;
}

export interface Placement {
  /** 1-based page. */
  page: number;
  /** The quote's folded [start, end) on that page. */
  start: number;
  end: number;
}

/** How much page text either side of a quote a comment keeps, in raw characters. */
export const CONTEXT_CHARS = 64;

/** Fold each page's text once; every comment is matched against the result. */
export const foldPages = (pages: string[]): string[] => pages.map((p) => fold(p).text);

/**
 * The page `anchor` now sits on, given each page's folded text (index 0 is
 * page 1). null if the quote is nowhere in the document — the passage was
 * rewritten — or too short to place.
 *
 * Among the pages holding the quote, the one whose surroundings best match the
 * remembered prefix/suffix wins. Ties (no context, or identical context) go:
 *   1. to the comment's current page, if it is one of them — nothing moved;
 *   2. otherwise to the run of consecutive pages nearest the old page, and to
 *      the FIRST page of that run. In beamer a passage revealed on overlay 2
 *      stays on overlays 3, 4…; the first one is where it appears, and it is
 *      what the comment was about on the slide that moved.
 */
export function placeQuote(foldedPages: string[], anchor: QuoteAnchor): Placement | null {
  const needle = fold(anchor.quote).text;
  if (needle.length < 4) return null;
  const pre = fold(anchor.prefix ?? '').text;
  const post = fold(anchor.suffix ?? '').text;

  // The best occurrence on each page that holds the quote.
  const exact = (text: string) => {
    const spans: { start: number; end: number }[] = [];
    for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) spans.push({ start: i, end: i + needle.length });
    return spans;
  };
  // An exact match anywhere beats a fuzzy one (head/tail, as the workspace's
  // highlighting allows) on the comment's own page.
  let found = foldedPages.map(exact);
  if (!found.some((s) => s.length)) {
    found = foldedPages.map((text) => {
      const m = findInFolded(text, needle);
      return m ? [m] : [];
    });
  }

  const scored: (Placement & { score: number })[] = [];
  found.forEach((spans, i) => {
    let best: (Placement & { score: number }) | null = null;
    for (const s of spans) {
      const text = foldedPages[i];
      const score = commonSuffixLength(pre, text.slice(0, s.start)) + commonPrefixLength(post, text.slice(s.end));
      if (!best || score > best.score) best = { page: i + 1, start: s.start, end: s.end, score };
    }
    if (best) scored.push(best);
  });
  if (!scored.length) return null;

  const top = Math.max(...scored.map((s) => s.score));
  const tied = scored.filter((s) => s.score === top);
  const strip = ({ page, start, end }: Placement) => ({ page, start, end });

  const stay = tied.find((s) => s.page === anchor.page);
  if (stay) return strip(stay);

  // Runs of consecutive pages, each represented by its first page.
  const runs: { first: Placement; lo: number; hi: number }[] = [];
  for (const s of tied) {
    const last = runs[runs.length - 1];
    if (last && s.page === last.hi + 1) last.hi = s.page;
    else runs.push({ first: s, lo: s.page, hi: s.page });
  }
  const distance = (r: { lo: number; hi: number }) =>
    anchor.page < r.lo ? r.lo - anchor.page : anchor.page > r.hi ? anchor.page - r.hi : 0;
  let pick = runs[0];
  for (const r of runs) if (distance(r) < distance(pick)) pick = r;
  return strip(pick.first);
}

/**
 * The prefix/suffix to remember for a quote placed at `p`, cut from the page's
 * raw text. Raw rather than folded so comments.json stays readable; matching
 * folds it anyway.
 */
export function contextAt(rawPage: string, p: Placement): { prefix: string; suffix: string } {
  const f = fold(rawPage);
  const startRaw = f.map[p.start] ?? 0;
  const endRaw = p.end > 0 && f.map[p.end - 1] !== undefined ? f.map[p.end - 1] + 1 : rawPage.length;
  return {
    prefix: rawPage.slice(Math.max(0, startRaw - CONTEXT_CHARS), startRaw),
    suffix: rawPage.slice(endRaw, endRaw + CONTEXT_CHARS),
  };
}
