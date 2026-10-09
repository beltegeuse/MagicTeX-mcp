// Text-match "SyncTeX" — the WASM engine can't emit a real .synctex map, so the
// workspace jumps between the PDF and the source, re-anchors comment highlights,
// and tells the agent which file:line a comment is about, all by matching the
// visible prose. Works well for prose (most of a paper); LaTeX-only lines
// (commands, math) simply won't match, which is fine — nothing jumps.
//
// Matching compares LETTERS ONLY: case- and accent-folded, with every space,
// line break, hyphen and punctuation mark dropped. Comparing words broke on
// exactly the text a paper is full of:
//   - an accented letter was a word break ("été" → "t"), so French prose fell
//     apart into one-letter fragments and highlight edges stopped short of it;
//   - pdf.js hands accents over in whichever form the font has (é, or e plus a
//     combining accent, or a separate ´ glyph), so the same word had several
//     spellings;
//   - "high-⏎lighting" in the PDF never matched "highlighting" in the source,
//     and pdf.js sometimes splits one word over two spans.
// Each kept character remembers where it came from, so a match maps straight
// back to the raw text it was found in.
//
// Shared by the server (anchorMatch.ts) and the workspace UI (ui/src/sync.ts
// re-exports it), so both always agree. Keep it free of Node and DOM APIs.

export interface Folded {
  /** Lowercase letters and digits only, accents removed. */
  text: string;
  /** For each character of `text`, the index in the raw string it came from. */
  map: number[];
}

// Letters that don't decompose to a base letter plus an accent.
const LETTER_FOLD: Record<string, string> = {
  'ß': 'ss', 'œ': 'oe', 'æ': 'ae', 'ø': 'o', 'ł': 'l', 'ı': 'i', 'ȷ': 'j', 'đ': 'd', 'ð': 'd', 'þ': 'th',
};
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
// Modifier letters (ˆ ˇ) are the accents a non-T1 font draws as glyphs of
// their own; they are \p{L} but carry no letter.
const MODIFIER_LETTER = /\p{Lm}/u;

/** Fold `raw` down to the letters and digits it shows; see {@link Folded}. */
export function fold(raw: string): Folded {
  let text = '';
  const map: number[] = [];
  let i = 0;
  for (const ch of raw) {
    if (ch < '\u0080') { // ASCII fast path: most of any page
      const c = ch.toLowerCase();
      if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) { text += c; map.push(i); }
      i++;
      continue;
    }
    // NFKD splits é into e + U+0301 and ﬁ into "fi"; the combining marks then
    // fail the letter test.
    for (const c of ch.toLowerCase().normalize('NFKD').toLowerCase()) {
      for (const k of LETTER_FOLD[c] ?? c) {
        if (LETTER_OR_DIGIT.test(k) && !MODIFIER_LETTER.test(k)) { text += k; map.push(i); }
      }
    }
    i += ch.length;
  }
  return { text, map };
}

// \ss, \oe, \o, \i … are letters, not markup: keep what they print.
const LETTER_MACROS: Record<string, string> = {
  ss: 'ss', oe: 'oe', ae: 'ae', aa: 'a', o: 'o', l: 'l', i: 'i', j: 'j',
};

/** Strip LaTeX so a source line reduces to its rendered prose. */
export function stripLatex(line: string): string {
  return line
    // A comment starts at a % after an EVEN run of backslashes: \% is a
    // percent sign, but \\% is a line break followed by a comment.
    .replace(/(^|[^\\])((?:\\\\)*)%.*$/, '$1$2')
    .replace(/\\(ss|oe|OE|ae|AE|aa|AA|o|O|l|L|i|j)(?![a-zA-Z])/g, (_, m: string) => LETTER_MACROS[m.toLowerCase()])
    // References print a number (or nothing), never their key.
    .replace(/\\(?:cite[a-zA-Z]*|[cC]?ref|eqref|autoref|pageref|label)\*?(?:\[[^\]]*\])*\{[^}]*\}/g, ' ')
    .replace(/\\[a-zA-Z@]+\*?/g, ' ') // \commands
    .replace(/[{}$&~^_\\]/g, ' ')   // markup punctuation
    .replace(/\[[^\]]*\]/g, ' ')    // optional args
    .trim();
}

// Phrase lengths, in folded characters (~8, 6, 4 and 3 words of prose), tried
// longest first so a match stays distinctive but still lands when the AI
// rewrote the words near one end of the quote.
const PHRASE_LENGTHS = [48, 32, 20, 12];

/** The head lengths to try for `needle`, longest first; see findHead. */
const headLengths = (needle: string, min: number) =>
  PHRASE_LENGTHS.filter((n, i) => (i === 0 || n >= min) && (i === 0 || n <= needle.length));

/**
 * Start of the longest head of `needle` found in `hay` at or after `from`, or
 * -1. Heads shorter than `min` aren't tried, except that a needle that short is
 * still tried whole.
 */
export function findHead(hay: string, needle: string, from = 0, min = 12): number {
  if (!needle) return -1;
  for (const n of headLengths(needle, min)) {
    const idx = hay.indexOf(needle.slice(0, n), from);
    if (idx >= 0) return idx;
  }
  return -1;
}

/**
 * Where a folded quote sits in folded text, as [start, end). Anchors by a head
 * and a tail rather than the whole quote, so it survives edits in the middle.
 */
export function findInFolded(hay: string, needle: string): { start: number; end: number } | null {
  if (!needle) return null;
  const whole = hay.indexOf(needle);
  if (whole >= 0) return { start: whole, end: whole + needle.length };
  const start = findHead(hay, needle);
  if (start < 0) return null;
  // The tail: of its occurrences within reach, the one ending nearest where
  // the quote would end. Taking the first one stopped the highlight early when
  // a short tail also appeared inside the quote ("…of the model … of the model").
  const expected = start + needle.length;
  for (const n of headLengths(needle, 12)) {
    const ph = needle.slice(-n);
    let best = -1;
    for (let i = hay.indexOf(ph, start); i >= 0 && i + n - start <= 2 * needle.length; i = hay.indexOf(ph, i + 1)) {
      if (best < 0 || Math.abs(i + n - expected) < Math.abs(best - expected)) best = i + n;
    }
    if (best > start) return { start, end: best };
  }
  return { start, end: Math.min(hay.length, expected) };
}

/** A LaTeX file folded into one string, so phrases match across line breaks. */
export interface FoldedSource {
  text: string;
  /** Where each source line begins in `text`; line i is [lineStart[i], lineStart[i + 1]). */
  lineStart: number[];
}

export function foldSource(content: string): FoldedSource {
  let text = '';
  const lineStart: number[] = [];
  for (const line of content.split(/\r?\n/)) {
    lineStart.push(text.length);
    text += fold(stripLatex(line)).text;
  }
  lineStart.push(text.length);
  return { text, lineStart };
}

/** The 0-based line holding folded offset `at`. */
const lineAt = (src: FoldedSource, at: number) => {
  let lo = 0, hi = src.lineStart.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (src.lineStart[mid] <= at) lo = mid; else hi = mid - 1;
  }
  // The LAST line starting at or before `at`: lines that fold to nothing share
  // their offset with the line after them, which is the one holding `at`.
  return lo;
};

/**
 * The best source line for `quote` across several files: the longest head of
 * the quote found in any file wins over a shorter one in an earlier file. If
 * no head matches, fall back to the longest source line whose prose the quote
 * contains — the quote then starts with something LaTeX generated, like the
 * "1" of "1 Introduction" or the "Figure 2:" of a caption.
 */
export function locateAcross<K>(sources: Iterable<[K, FoldedSource]>, quote: string): { key: K; line: number } | null {
  const needle = fold(quote).text;
  if (needle.length < 4) return null; // too short to tell one place from another
  const all = [...sources];
  for (const min of [PHRASE_LENGTHS[0], 20]) {
    for (const [key, src] of all) {
      const at = findHead(src.text, needle, 0, min);
      if (at >= 0) return { key, line: lineAt(src, at) };
    }
  }
  let best: { key: K; line: number; len: number } | null = null;
  for (const [key, src] of all) {
    for (let i = 0; i + 1 < src.lineStart.length; i++) {
      const len = src.lineStart[i + 1] - src.lineStart[i];
      if (len <= 10 || (best && len <= best.len)) continue;
      if (needle.includes(src.text.slice(src.lineStart[i], src.lineStart[i + 1]))) best = { key, line: i, len };
    }
  }
  return best && { key: best.key, line: best.line };
}

/** The 0-based line of `content` (a LaTeX file) where `quote` starts, or null. */
export function locateInSource(content: string, quote: string): number | null {
  return locateAcross([[null, foldSource(content)]], quote)?.line ?? null;
}
