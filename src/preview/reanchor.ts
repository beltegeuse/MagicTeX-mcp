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
// Pure (no Node or DOM APIs) so the choice can be tested on synthetic pages, and
// shared with the workspace, which highlights the same spot.
import { fold, findInFolded, commonPrefixLength, commonSuffixLength, contextScore, type Folded } from './textMatch.js';

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
export interface AnchoredComment extends QuoteAnchor {
  rects: unknown[];
  /** Distinctive phrases of the page the quote was last found on (folded). */
  pageSig?: string[];
}

/**
 * Where a comment now is: the fields that changed. `stale: false` clears the
 * flag; `current: null` clears `current`.
 */
export interface AnchorUpdate {
  page?: number;
  rects?: { x: number; y: number; w: number; h: number }[];
  prefix?: string;
  suffix?: string;
  stale?: boolean;
  current?: string | null;
  pageSig?: string[];
}

/**
 * How a comment was found:
 *   exact   — its quote, letter for letter;
 *   fuzzy   — the quote's head and tail, with its middle rewritten;
 *   context — not the quote, but the text that was around it: what sits between
 *             is what replaced the quote (nothing, if it was deleted);
 *   estimate — only the page, from phrases of the page it was on.
 */
export type FoundBy = 'exact' | 'fuzzy' | 'context' | 'estimate';

export interface Placement {
  /** 1-based page. */
  page: number;
  /** The passage's folded [start, end) on that page; start === end for a deletion. */
  start: number;
  end: number;
  by: FoundBy;
  rough?: boolean;
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
/** Letters of context that must match before a guess from context is believed. */
const MIN_CONTEXT = 16;
/** Phrase length of a page signature, in folded characters. */
const SIG_PHRASE = 16;

/** Fold each page's text once; every comment is matched against the result. */
export const foldPages = (pages: string[]): string[] => pages.map((p) => fold(p).text);

/**
 * A PDF's pages, raw and folded, folded once per re-anchoring pass: the
 * folded-to-raw maps are what cut a comment's context and replacement text out
 * of the raw page, and re-folding a page per comment repeated the same work.
 */
export interface FoldedDoc { raw: string[]; folds: Folded[]; text: string[] }

export function foldDoc(pages: string[]): FoldedDoc {
  const folds = pages.map((p) => fold(p));
  return { raw: pages, folds, text: folds.map((f) => f.text) };
}

interface Hit {
  start: number; end: number; score: number; count: number; by: FoundBy;
  /** Its edges were found a few letters off: they may fall inside a word. */
  rough?: boolean;
}

/** The exact occurrence of `needle` whose surroundings match best; `count` is how many there are. */
function exactOn(text: string, needle: string, pre: string, post: string): Hit | null {
  let best: Hit | null = null, count = 0;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
    count++;
    const score = contextScore(text, i, i + needle.length, pre, post);
    if (!best || score > best.score) best = { start: i, end: i + needle.length, score, count: 0, by: 'exact' };
  }
  return best && { ...best, count };
}

/**
 * Where the quote was, from the text that was around it: a piece of the prefix,
 * then — not much further — a piece of the suffix. What lies between is what
 * replaced the quote; an empty span is a deletion.
 *
 * The pieces are tried from the edges inwards (`drop` letters skipped next to
 * the quote), because whoever rewrites a passage often rewrites the words
 * right next to it too. A piece found that way is then grown back towards the
 * quote letter by letter for as long as the old context still matches, so the
 * span starts exactly where the new text departs from the old — the edited
 * words are in it, and nothing more. That point can fall inside a word (an
 * ending changed), so the span is `rough`.
 */
function gapOn(text: string, needleLength: number, pre: string, post: string): Hit | null {
  if (pre.length + post.length < MIN_CONTEXT) return null;
  const maxGap = 3 * needleLength + 120;
  // Each candidate edge, with how much it is worth: the piece's length, less
  // for each letter skipped.
  const edges = (side: string, isPre: boolean) => {
    const out = new Map<number, { value: number; rough: boolean }>();
    if (!side) return out;
    for (const drop of [0, 8, 16, 24]) {
      for (const k of [32, 16, 8]) {
        const piece = isPre ? side.slice(Math.max(0, side.length - drop - k), side.length - drop) : side.slice(drop, drop + k);
        if (piece.length < Math.min(8, side.length - drop) || piece.length < 4) continue;
        const skipped = isPre ? side.slice(side.length - drop) : side.slice(0, drop);
        for (let i = text.indexOf(piece); i >= 0; i = text.indexOf(piece, i + 1)) {
          // Grow the piece back over the letters skipped, while they still match.
          const grown = !drop ? 0 : isPre
            ? commonPrefixLength(skipped, text.slice(i + piece.length, i + piece.length + drop))
            : commonSuffixLength(skipped, text.slice(Math.max(0, i - drop), i));
          const at = isPre ? i + piece.length + grown : i - grown;
          const value = piece.length + grown - (drop - grown) / 2;
          if ((out.get(at)?.value ?? -Infinity) < value) out.set(at, { value, rough: grown < drop });
        }
      }
    }
    return out;
  };
  const starts = edges(pre, true), ends = edges(post, false);

  let best: Hit | null = null, count = 0;
  const consider = (start: number, end: number, value: number, rough: boolean) => {
    const score = Math.max(value, contextScore(text, start, end, pre, post));
    if (score < MIN_CONTEXT) return;
    count++;
    if (!best || score > best.score) best = { start, end, score, count: 0, by: 'context', rough };
  };
  if (starts.size && ends.size) {
    for (const [start, s] of starts) {
      for (const [end, e] of ends) {
        if (end >= start && end - start <= maxGap) consider(start, end, s.value + e.value, s.rough || e.rough);
      }
    }
  } else if (!post) { // the quote ended the page
    for (const [start, s] of starts) if (text.length - start <= maxGap) consider(start, text.length, s.value, s.rough);
  } else if (!pre) { // the quote began the page
    for (const [end, e] of ends) if (end <= maxGap) consider(0, end, e.value, e.rough);
  }
  return best && { ...(best as Hit), count };
}

/**
 * The quote's head and tail with the middle rewritten (findInFolded), or the
 * context around where it was, whichever matches the context better. Used once
 * the quote itself is nowhere to be found.
 */
function looseOn(text: string, needle: string, pre: string, post: string): Hit | null {
  const m = findInFolded(text, needle);
  const fuzzy: Hit | null = m && { ...m, score: contextScore(text, m.start, m.end, pre, post), count: 1, by: 'fuzzy' };
  const gap = gapOn(text, needle.length, pre, post);
  if (!gap) return fuzzy;
  return fuzzy && fuzzy.score >= gap.score ? fuzzy : gap;
}

const folds = (a: Omit<QuoteAnchor, 'page'>) =>
  ({ needle: fold(a.quote).text, pre: fold(a.prefix ?? '').text, post: fold(a.suffix ?? '').text });

/**
 * Where on one page the comment's passage is: its quote (the occurrence whose
 * surroundings match best, not merely the first), or failing that whatever now
 * sits where the quote was. start === end marks a deletion. The workspace uses
 * it to highlight the same spot the server placed the comment by.
 *
 * Once the server has worked out what replaced the quote (`current`, whole
 * words), that text is looked for first: the span found from the context alone
 * can start a letter or two off when old and new text happen to share them
 * ("…égaux.Cette" / "…égaux.Chaque").
 */
export function locateOn(foldedPage: string, anchor: Omit<QuoteAnchor, 'page'> & { current?: string }): { start: number; end: number } | null {
  const { needle, pre, post } = folds(anchor);
  if (!needle) return null;
  const now = fold(anchor.current ?? '').text;
  const m = exactOn(foldedPage, needle, pre, post)
    ?? (now.length >= MIN_QUOTE ? exactOn(foldedPage, now, pre, post) : null)
    ?? looseOn(foldedPage, needle, pre, post);
  return m && { start: m.start, end: m.end };
}

/**
 * Of the pages with a hit, the best one. Ties (no context, or identical
 * context) go:
 *   1. to the comment's current page, if it is one of them — nothing moved;
 *   2. otherwise to the run of consecutive pages nearest the old page, and to
 *      the FIRST page of that run. In beamer a passage revealed on overlay 2
 *      stays on overlays 3, 4…; the first one is where it appears, and it is
 *      what the comment was about on the slide that moved.
 */
function choose(hits: (Hit & { page: number })[], oldPage: number): Placement {
  const top = Math.max(...hits.map((s) => s.score));
  const tied = hits.filter((s) => s.score === top);
  const sure = tied.length === 1 && (top > 0 || tied[0].count === 1);
  const done = ({ page, start, end, by, rough }: Hit & { page: number }): Placement => ({ page, start, end, by, rough, sure });

  const stay = tied.find((s) => s.page === oldPage);
  if (stay) return done(stay);

  const runs: { first: Hit & { page: number }; lo: number; hi: number }[] = [];
  for (const s of tied) {
    const last = runs[runs.length - 1];
    if (last && s.page === last.hi + 1) last.hi = s.page;
    else runs.push({ first: s, lo: s.page, hi: s.page });
  }
  const distance = (r: { lo: number; hi: number }) =>
    oldPage < r.lo ? r.lo - oldPage : oldPage > r.hi ? oldPage - r.hi : 0;
  let pick = runs[0];
  for (const r of runs) if (distance(r) < distance(pick)) pick = r;
  return done(pick.first);
}

/**
 * Where `anchor` is now, given each page's folded text (index 0 is page 1).
 * Tried from the most to the least precise — the quote; its head and tail; the
 * text around where it was; the page it was on, from its signature — so a
 * comment whose passage was rewritten or deleted (which is what addressing it
 * usually means) still knows where it is. 'missing' if none of that is left,
 * null if the quote is too short to place at all.
 */
export function locate(foldedPages: string[], anchor: AnchoredComment): Placement | 'missing' | null {
  const { needle, pre, post } = folds(anchor);
  if (needle.length < MIN_QUOTE) return null;

  const collect = (on: (text: string) => Hit | null) => {
    const out: (Hit & { page: number })[] = [];
    foldedPages.forEach((text, i) => {
      const m = on(text);
      if (m) out.push({ ...m, page: i + 1 });
    });
    return out;
  };
  // An exact match anywhere beats a loose one on the comment's own page.
  let hits = collect((t) => exactOn(t, needle, pre, post));
  if (!hits.length) hits = collect((t) => looseOn(t, needle, pre, post));
  if (hits.length) return choose(hits, anchor.page);

  // The page only: the one holding most of the phrases its old page had.
  const sig = anchor.pageSig ?? [];
  const heads = [pre.slice(-SIG_PHRASE), post.slice(0, SIG_PHRASE)].filter((p) => p.length === SIG_PHRASE);
  const phrases = [...sig, ...heads];
  if (!phrases.length) return 'missing';
  const scored = foldedPages.map((t, i) => ({
    page: i + 1, start: 0, end: 0, count: 1, by: 'estimate' as const,
    score: phrases.filter((p) => t.includes(p)).length,
  })).filter((s) => s.score >= Math.min(2, phrases.length));
  if (!scored.length) return 'missing';
  return { ...choose(scored, anchor.page), sure: false };
}

/**
 * Up to 8 phrases of page `page` that few other pages share — what identifies
 * the page once the quote itself is gone. The quote's own letters are left
 * out (they are what an edit changes), and so is a running header, which every
 * page has.
 */
export function pageSignature(foldedPages: string[], page: number, start: number, end: number): string[] {
  const text = foldedPages[page - 1] ?? '';
  const rare: string[] = [];
  for (let i = 0; i + SIG_PHRASE <= text.length; i += SIG_PHRASE) {
    if (i < end && i + SIG_PHRASE > start) continue;
    const ph = text.slice(i, i + SIG_PHRASE);
    let n = 0;
    for (const t of foldedPages) if (t.includes(ph) && ++n > 4) break;
    if (n <= 4) rare.push(ph);
  }
  if (rare.length <= 8) return rare;
  return Array.from({ length: 8 }, (_, k) => rare[Math.floor((k * rare.length) / 8)]);
}

/**
 * The raw text behind folded [start, end) of `rawPage`. A `rough` span may start
 * or end inside a word ("égaux" → "égales" leaves "les"), so it is widened to
 * the whole word — but not across a lowercase-to-uppercase step: pdf.js joins
 * lines with nothing between them, so "égaux.Chaque" or "PartagéeUne" are two
 * words, not one.
 */
function rawSpan(rawPage: string, start: number, end: number, rough = false, f: Folded = fold(rawPage)): string {
  if (end <= start) return '';
  let a = f.map[start], b = f.map[end - 1];
  if (a === undefined || b === undefined) return '';
  if (rough) {
    const letter = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);
    const joined = (x: string, y: string) => letter(x) && letter(y) && !(/\p{Ll}/u.test(x) && /\p{Lu}/u.test(y));
    while (a > 0 && joined(rawPage[a - 1], rawPage[a])) a--;
    while (b + 1 < rawPage.length && joined(rawPage[b], rawPage[b + 1])) b++;
  }
  return rawPage.slice(a, b + 1).trim();
}

/**
 * The prefix/suffix to remember for a quote placed at `p`, cut from the page's
 * raw text. Raw rather than folded so comments.json stays readable; matching
 * folds it anyway.
 */
export function contextAt(
  rawPage: string, p: Pick<Placement, 'start' | 'end'>, f: Folded = fold(rawPage),
): { prefix: string; suffix: string } {
  const startRaw = f.map[p.start] ?? 0;
  const endRaw = p.end > 0 && f.map[p.end - 1] !== undefined ? f.map[p.end - 1] + 1 : rawPage.length;
  return {
    prefix: rawPage.slice(Math.max(0, startRaw - CONTEXT_CHARS), startRaw),
    suffix: rawPage.slice(endRaw, endRaw + CONTEXT_CHARS),
  };
}

/**
 * What re-anchoring changes on comment `c`, given the new PDF's pages, or null
 * to leave it alone.
 */
export function anchorUpdate(doc: FoldedDoc, c: AnchoredComment): AnchorUpdate | null {
  const p = locate(doc.text, c);
  if (!p) return null; // too short to place
  // An agent's quote that never matched the PDF (copied from the source, say)
  // was never anywhere, so it can't have moved or been edited.
  const wasFound = c.rects.length > 0 || c.prefix !== undefined || c.suffix !== undefined || !!c.pageSig?.length;
  // Nothing left to go on: the old behaviour — its page, and its boxes. What
  // once replaced the quote is gone too, so it no longer says what stands there.
  if (p === 'missing') return wasFound ? { stale: true, current: null } : null;
  if (p.by === 'estimate') {
    if (!wasFound) return null;
    return p.page === c.page ? { stale: true, current: null } : { page: p.page, rects: [], stale: true, current: null };
  }

  const u: AnchorUpdate = { page: p.page, stale: false };
  // The stored boxes belong to the old page; the workspace re-finds the text.
  if (p.page !== c.page) u.rects = [];
  if (p.by === 'exact') {
    u.current = null;
    // The signature is about the page's words, not its number: a page that only
    // moved keeps it. It is redone (it scans every page) only when it no longer
    // describes the page the quote is on.
    const text = doc.text[p.page - 1];
    const sig = c.pageSig ?? [];
    if (sig.filter((ph) => text.includes(ph)).length * 2 < sig.length || !sig.length) {
      u.pageSig = pageSignature(doc.text, p.page, p.start, p.end);
    }
    // A comment without context gets it only once its spot is certain.
    if (c.prefix === undefined && c.suffix === undefined && p.sure) {
      Object.assign(u, contextAt(doc.raw[p.page - 1], p, doc.folds[p.page - 1]));
    }
  } else {
    // Rewritten or deleted — most likely by whoever addressed the comment.
    u.current = rawSpan(doc.raw[p.page - 1], p.start, p.end, p.rough, doc.folds[p.page - 1]).slice(0, 600);
  }
  return u;
}
