// Locate a PDF comment's quoted passage back in the LaTeX source, so the agent
// loop gets a precise {file, line} to edit instead of having to search. Same
// text-match heuristic the workspace uses for PDF↔source sync (the WASM engine
// can't emit a real SyncTeX map): match the visible prose, ignore LaTeX markup
// — see textMatch.ts. Works for prose (the bulk of a paper); command/math-only
// lines simply won't match, and the agent falls back to searching for the
// quote itself.
import { listTextFiles, readTextFile } from './filesApi.js';
import { foldSource, locateAcross, type FoldedSource } from './textMatch.js';

export interface Anchor { file: string; line: number; snippet: string }

/** Find the source file+line whose prose best matches `quote`, or null. */
export async function findAnchor(root: string, quote: string): Promise<Anchor | null> {
  let files: string[];
  try { files = await listTextFiles(root); } catch { return null; }
  const texish = files.filter((f) => /\.(tex|bib|cls|sty)$/i.test(f));

  const contents = new Map<string, string>();
  const sources: [string, FoldedSource][] = [];
  for (const f of texish) {
    let content: string;
    try { content = await readTextFile(root, f); } catch { continue; }
    contents.set(f, content);
    sources.push([f, foldSource(content)]);
  }
  const hit = locateAcross(sources, quote);
  if (!hit) return null;
  const lines = contents.get(hit.key)!.split(/\r?\n/);
  const snippet = lines.slice(Math.max(0, hit.line - 1), hit.line + 2).join('\n');
  return { file: hit.key, line: hit.line + 1, snippet };
}
