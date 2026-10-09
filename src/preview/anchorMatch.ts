// Locate a PDF comment's quoted passage back in the LaTeX source, so the agent
// loop gets a precise {file, line} to edit instead of having to search. Same
// text-match heuristic the workspace uses for PDF↔source sync (the WASM engine
// can't emit a real SyncTeX map): match the visible prose, ignore LaTeX markup
// — see textMatch.ts. Works for prose (the bulk of a paper); command/math-only
// lines simply won't match, and the agent falls back to searching for the
// quote itself.
import { listTextFiles, readTextFile } from './filesApi.js';
import {
  commonPrefixLength, commonSuffixLength, fold, foldSource, locateAllAcross, type FoldedSource, type SourceHit,
} from './textMatch.js';

export interface Anchor { file: string; line: number; snippet: string }

/** What else the PDF says about where a quote is. */
export interface AnchorContext {
  /** Page text just before / after the quote (the comment's prefix/suffix). */
  prefix?: string;
  suffix?: string;
  /** The whole text of the page the quote is on. */
  pageText?: string;
}

// Phrases of the page, in folded characters, looked for around each hit.
const PHRASE = 16;

/**
 * Of several places a short quote appears ("Partagée" is in half the files of a
 * French deck), the one the comment is about: the source around it should read
 * like the PDF around it. Two signals, both from the comment's page:
 *   - the prefix/suffix right next to the quote, matched letter by letter;
 *   - how many phrases of that page sit near the hit in the same file — for a
 *     beamer frame, its title and the rest of its text.
 */
function pickHit(hits: SourceHit<string>[], folded: Map<string, FoldedSource>, needle: string, ctx: AnchorContext): SourceHit<string> {
  const pre = fold(ctx.prefix ?? '').text;
  const post = fold(ctx.suffix ?? '').text;
  const page = fold(ctx.pageText ?? '').text;
  const phrases = new Set<string>();
  for (let i = 0; i + PHRASE <= page.length; i += PHRASE) phrases.add(page.slice(i, i + PHRASE));
  phrases.delete(needle.slice(0, PHRASE));
  const reach = page.length + 500;

  let best = hits[0], bestScore = -1;
  for (const h of hits) {
    const text = folded.get(h.key)!.text;
    let near = 0;
    if (phrases.size) {
      const around = text.slice(Math.max(0, h.at - reach), h.at + needle.length + reach);
      for (const ph of phrases) if (around.includes(ph)) near++;
    }
    const score = commonSuffixLength(pre, text.slice(Math.max(0, h.at - pre.length), h.at))
      + commonPrefixLength(post, text.slice(h.at + needle.length, h.at + needle.length + post.length))
      + PHRASE * near;
    if (score > bestScore) { best = h; bestScore = score; }
  }
  return best;
}

/**
 * Find the source file+line whose prose best matches `quote`, or null. With
 * `ctx`, a quote found in several places is told apart by its page.
 */
export async function findAnchor(root: string, quote: string, ctx: AnchorContext = {}): Promise<Anchor | null> {
  let files: string[];
  try { files = await listTextFiles(root); } catch { return null; }
  const texish = files.filter((f) => /\.(tex|bib|cls|sty)$/i.test(f));

  const contents = new Map<string, string>();
  const sources: [string, FoldedSource][] = [];
  const folded = new Map<string, FoldedSource>();
  for (const f of texish) {
    let content: string;
    try { content = await readTextFile(root, f); } catch { continue; }
    contents.set(f, content);
    const src = foldSource(content);
    sources.push([f, src]);
    folded.set(f, src);
  }
  const hits = locateAllAcross(sources, quote);
  if (!hits.length) return null;
  const hit = hits.length === 1 ? hits[0] : pickHit(hits, folded, fold(quote).text, ctx);
  const lines = contents.get(hit.key)!.split(/\r?\n/);
  const snippet = lines.slice(Math.max(0, hit.line - 1), hit.line + 2).join('\n');
  return { file: hit.key, line: hit.line + 1, snippet };
}
