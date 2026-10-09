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

/** A comment as re-anchoring sees it (structurally, so the UI can share this file). */
export interface AnchoredComment extends QuoteAnchor { rects: unknown[] }

/** Where a comment now is: the fields that changed. `stale: false` clears the flag. */
export interface AnchorUpdate {
  page?: number;
  rects?: { x: number; y: number; w: number; h: number }[];
  prefix?: string;
  suffix?: string;
  stale?: boolean;
}

export interface Placement {
  /** 1-based page. */
  page: number;
  /** The quote's folded [start, end) on that page. */
  start: number;
  end: number;
  /**
   * Whether this is the only place it could be: one page beats all others, and
   * on it either the context decided or the quote occurs once. Only then is it
   * safe to remember this spot's context — a tie-break guess, written down as
   * context, would vouch for itself on every later compile.
   */
  sure: boolean;
}

/** How much page text either side of a quote a comment keeps, in raw characters. */
export const CONTEXT_CHARS = 64;

/** A quote folded to fewer letters than this can't be told from noise. */
const MIN_QUOTE = 4;

/** Fold each page's text once; every comment is matched against the result. */
export const foldPages = (pages: string[]): string[] => pages.map((p) => fold(p).text);

interface Scored { start: number; end: number; score: number; count: number }

/**
 * The occurrence of folded `needle` on one folded page whose surroundings best
 * match the folded context, or null. Exact occurrences are scored; with none,
 * the fuzzier head/tail match the highlighting has always allowed (`fuzzy`).
 * `count` is how many exact occurrences the page holds.
 */
function bestOn(text: string, needle: string, pre: string, post: string, fuzzy: boolean): Scored | null {
  let best: Scored | null = null, count = 0;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
    count++;
    const end = i + needle.length;
    const score = commonSuffixLength(pre, text.slice(Math.max(0, i - pre.length), i))
      + commonPrefixLength(post, text.slice(end, end + post.length));
    if (!best || score > best.score) best = { start: i, end, score, count: 0 };
  }
  if (best) return { ...best, count };
  if (!fuzzy) return null;
  const m = findInFolded(text, needle);
  return m && { ...m, score: 0, count: 1 };
}

/**
 * Where on one page the comment's quote is: the occurrence whose surroundings
 * match its prefix/suffix best, not merely the first. The workspace uses it to
 * highlight the same occurrence the server placed the comment by.
 */
export function occurrenceOn(foldedPage: string, anchor: Omit<QuoteAnchor, 'page'>): { start: number; end: number } | null {
  const needle = fold(anchor.quote).text;
  if (!needle) return null;
  const m = bestOn(foldedPage, needle, fold(anchor.prefix ?? '').text, fold(anchor.suffix ?? '').text, true);
  return m && { start: m.start, end: m.end };
}

/**
 * The page `anchor` now sits on, given each page's folded text (index 0 is
 * page 1): a Placement, 'missing' if the quote is nowhere in the document (the
 * passage was rewritten), or null if it is too short to place at all.
 *
 * Among the pages holding the quote, the one whose surroundings best match the
 * remembered prefix/suffix wins. Ties (no context, or identical context) go:
 *   1. to the comment's current page, if it is one of them — nothing moved;
 *   2. otherwise to the run of consecutive pages nearest the old page, and to
 *      the FIRST page of that run. In beamer a passage revealed on overlay 2
 *      stays on overlays 3, 4…; the first one is where it appears, and it is
 *      what the comment was about on the slide that moved.
 */
export function placeQuote(foldedPages: string[], anchor: QuoteAnchor): Placement | 'missing' | null {
  const needle = fold(anchor.quote).text;
  if (needle.length < MIN_QUOTE) return null;
  const pre = fold(anchor.prefix ?? '').text;
  const post = fold(anchor.suffix ?? '').text;

  // An exact match anywhere beats a fuzzy one on the comment's own page.
  const find = (fuzzy: boolean) => {
    const out: (Scored & { page: number })[] = [];
    foldedPages.forEach((text, i) => {
      const m = bestOn(text, needle, pre, post, fuzzy);
      if (m) out.push({ ...m, page: i + 1 });
    });
    return out;
  };
  let scored = find(false);
  if (!scored.length) scored = find(true);
  if (!scored.length) return 'missing';

  const top = Math.max(...scored.map((s) => s.score));
  const tied = scored.filter((s) => s.score === top);
  const sure = tied.length === 1 && (top > 0 || tied[0].count === 1);
  const done = ({ page, start, end }: { page: number; start: number; end: number }): Placement => ({ page, start, end, sure });

  const stay = tied.find((s) => s.page === anchor.page);
  if (stay) return done(stay);

  // Runs of consecutive pages, each represented by its first page.
  const runs: { first: Scored & { page: number }; lo: number; hi: number }[] = [];
  for (const s of tied) {
    const last = runs[runs.length - 1];
    if (last && s.page === last.hi + 1) last.hi = s.page;
    else runs.push({ first: s, lo: s.page, hi: s.page });
  }
  const distance = (r: { lo: number; hi: number }) =>
    anchor.page < r.lo ? r.lo - anchor.page : anchor.page > r.hi ? anchor.page - r.hi : 0;
  let pick = runs[0];
  for (const r of runs) if (distance(r) < distance(pick)) pick = r;
  return done(pick.first);
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

/**
 * What re-anchoring changes on comment `c`, given the new PDF's pages (raw and
 * folded), or null to leave it alone.
 */
export function anchorUpdate(folded: string[], pages: string[], c: AnchoredComment): AnchorUpdate | null {
  const p = placeQuote(folded, c);
  if (!p) return null; // too short to place
  if (p === 'missing') {
    // Stale only if it was ever found: an agent's quote that never matched the
    // PDF (copied from the source, say) is not "already edited". The frozen
    // boxes go, or they would paint over whatever took the passage's place.
    const wasFound = c.rects.length > 0 || c.prefix !== undefined || c.suffix !== undefined;
    return wasFound ? { stale: true, rects: [] } : null;
  }
  const u: AnchorUpdate = { page: p.page, stale: false };
  // The stored boxes belong to the old page; the workspace re-finds the text.
  if (p.page !== c.page) u.rects = [];
  // A comment without context gets it only once its spot is certain.
  if (c.prefix === undefined && c.suffix === undefined && p.sure) Object.assign(u, contextAt(pages[p.page - 1], p));
  return u;
}
