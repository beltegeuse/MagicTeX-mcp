// A comment must keep track of its passage through being addressed.
//
// A comment asks for its passage to be rewritten or deleted, so once it is
// addressed its quote no longer exists. Comments used to be pinned to a page
// number, and then to their quote: after the edit — usually alongside pages
// added before it — check_comments sent the agent to the wrong page, and the
// highlight the author reviews (green, "addressed") either vanished or sat on
// unrelated text.
//
// Driven end to end, the way it happens: a comment made by selecting text in
// the workspace, one posted by an agent, then an agent's edits to the .tex
// (rewrite one passage, delete the other, add a page before both), the
// recompile the file watcher starts, resolve_comment, and one more page added.
//
//   node scripts/smoke-comment-tracking.mjs
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

// ui/dist is gitignored and built separately. The workspace bundles the
// matching code from src/preview too, so a dist older than either tests the
// wrong code — which is how a fixed bug once still showed up here.
{
  const newest = (dir) => {
    let t = 0;
    for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (e.isFile()) t = Math.max(t, statSync(join(e.parentPath ?? e.path, e.name)).mtimeMs);
    }
    return t;
  };
  let dist = 0;
  try { dist = newest(join(REPO, 'ui', 'dist')); } catch { /* not built */ }
  if (dist < Math.max(newest(join(REPO, 'ui', 'src')), newest(join(REPO, 'src', 'preview')))) {
    console.error('ui/dist is older than ui/src or src/preview — run `npm run build:ui` first, or this tests the wrong code.');
    process.exit(1);
  }
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n      ${detail}` : ''}`);
};

// One page per \newpage block, so the expected page of each passage is known.
const REWRITE = 'Cette phrase explique la méthode de façon confuse.';
const REWRITTEN = 'Chaque thread calcule une somme partielle, puis on les additionne.';
const DELETE = 'Cette remarque est hors sujet et doit disparaître.';
const page = (title, ...lines) => [String.raw`\section*{${title}}`, ...lines, '', String.raw`\newpage`];
const doc = (extraPages, { rewritten = false, deleted = false } = {}) => [
  String.raw`\documentclass{article}`,
  String.raw`\begin{document}`,
  ...page('Introduction', 'OpenMP parallélise une boucle sans réécrire le programme.'),
  ...Array.from({ length: extraPages }, (_, i) => page(`Ajout ${i + 1}`, `Une page ajoutée avant les autres, la numéro ${i + 1}.`)),
  ...page('Méthode', 'Nous découpons le tableau en blocs égaux.', '', rewritten ? REWRITTEN : REWRITE, '', 'Les blocs sont ensuite combinés par le thread principal.'),
  ...page('Discussion', 'Le faux partage ralentit les écritures voisines.', '', ...(deleted ? [] : [DELETE, '']), 'La mesure le confirme avec perf stat.'),
  ...page('Conclusion', 'Fin du document.'),
  String.raw`\end{document}`,
  '',
].join('\n');

const proj = mkdtempSync(join(tmpdir(), 'magictex-tracking-'));
const main = join(proj, 'main.tex');
writeFileSync(main, doc(0));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, join(REPO, 'src', 'server.ts')],
  cwd: proj,
  stderr: 'ignore',
});
const client = new Client({ name: 'tracking-smoke', version: '0' }, { capabilities: {} });
await client.connect(transport);
const text = (r) => r.content.map((c) => c.text ?? '').join('\n');
const tool = async (name, args = {}) => text(await client.callTool({ name, arguments: args }, undefined, { timeout: 15 * 60 * 1000 }));

/** Poll `fn` until it returns a truthy value or `ms` pass; resolves to its last value. */
const until = async (fn, ms = 5 * 60 * 1000) => {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return v;
};
/** The check_comments entry of comment `id`. */
const entry = (out, id) => out.split('\n\n').find((e) => e.includes(`[id: ${id}]`)) ?? '';
const lineOf = (needle) => readFileSync(main, 'utf8').split('\n').findIndex((l) => l.includes(needle)) + 1;

const browser = await chromium.launch();
const tab = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
try {
  const out = await tool('render_preview', { backend: 'wasm' });
  const base = out.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  if (!base) throw new Error(`no workspace URL:\n${out.slice(0, 400)}`);
  await tab.goto(`${base}/app`, { waitUntil: 'load', timeout: 60_000 });
  await tab.waitForSelector('.page[data-page="4"] .textLayer span', { timeout: 60_000 });
  await tab.waitForTimeout(500);

  // ── A human comment, made by selecting the passage in the PDF ───────────
  const picked = await tab.evaluate((phrase) => {
    for (const span of document.querySelectorAll('.page .textLayer span')) {
      const node = span.firstChild;
      const at = node?.textContent?.indexOf(phrase) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + phrase.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return span.closest('.page').dataset.page;
    }
    return null;
  }, 'la méthode de façon confuse');
  check('the passage to rewrite is on page 2', picked === '2', `found on page ${picked}`);
  await tab.fill('.composer textarea', 'Réécris cette phrase.');
  await tab.click('.composer button.on');

  // ── An agent's comment, on the passage to delete ────────────────────────
  const added = await tool('add_comment', { quote: 'hors sujet et doit disparaître', comment: 'Supprime cette remarque.', accepted: true });
  const agentId = added.match(/comment (\S+) posted/)?.[1];
  const listed = await until(async () => { const o = await tool('check_comments'); return /2 accepted comments/.test(o) && o; }, 20_000);
  const humanId = listed?.match(/\[id: (\S+)\] p\.2/)?.[1];
  check('both comments are listed on their pages', !!humanId && /p\.3/.test(entry(listed, agentId)), listed?.slice(0, 600));

  // ── Address them as an agent would: edit the .tex, add a page before ────
  writeFileSync(main, doc(1, { rewritten: true, deleted: true }));
  const addressed = await until(async () => {
    const o = await tool('check_comments');
    return /p\.3 \(passage edited/.test(entry(o, humanId)) && /p\.4 \(passage deleted\)/.test(entry(o, agentId)) && o;
  });
  const h = entry(addressed ?? '', humanId), a = entry(addressed ?? '', agentId);
  check('the rewritten passage moved with its page, and its new text is known', h.includes(`p.3 (passage edited, now: "${REWRITTEN.replace(/\.$/, '')}")`), h);
  check('the deleted passage moved with its page, and is known to be deleted', a.includes('p.4 (passage deleted)'), a);
  check('the rewritten passage points at its new source line', h.includes(`main.tex:${lineOf(REWRITTEN)}`), `${h}\n      expected main.tex:${lineOf(REWRITTEN)}`);
  check('the deleted passage points at the line that followed it', a.includes(`main.tex:${lineOf('La mesure le confirme')}`), `${a}\n      expected main.tex:${lineOf('La mesure le confirme')}`);
  check('neither is reported as a guess', !/page estimated/.test(h + a));

  await tool('resolve_comment', { id: humanId, note: 'rewritten' });
  await tool('resolve_comment', { id: agentId, note: 'deleted' });

  // ── Once resolved, they still follow their passage ──────────────────────
  writeFileSync(main, doc(2, { rewritten: true, deleted: true }));
  const later = await until(async () => {
    const o = await tool('check_comments', { includeResolved: true });
    return /p\.4 \(passage edited/.test(entry(o, humanId)) && /p\.5 \(passage deleted\)/.test(entry(o, agentId)) && o;
  });
  check('resolved comments keep following their passage', !!later, entry(later ?? '', humanId) + '\n      ' + entry(later ?? '', agentId));

  // The workspace draws the green "addressed" highlight on the NEW text, and a
  // caret where the deleted passage was.
  const drawn = await until(() => tab.evaluate(([hid, aid]) => {
    const pageOf = (el) => el?.closest('.page')?.dataset.page;
    const boxes = [...document.querySelectorAll(`.hl[data-id="${hid}"]`)];
    const hl = boxes[0];
    const caret = document.querySelector(`.hl.hl-caret[data-id="${aid}"]`);
    if (!hl || !caret) return null;
    // The lines under the highlight, all its boxes together.
    const under = [...hl.closest('.page').querySelectorAll('.textLayer span')]
      .filter((s) => {
        const r = s.getBoundingClientRect();
        // Covered over most of its height: neighbouring lines touch by a pixel.
        return boxes.some((h) => {
          const b = h.getBoundingClientRect();
          return Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top) > r.height / 2 && r.right > b.left && r.left < b.right;
        });
      })
      .map((s) => s.textContent).join(' ');
    return { hlPage: pageOf(hl), resolved: hl.classList.contains('hl-resolved'), under, caretPage: pageOf(caret), caretW: caret.getBoundingClientRect().width };
  }, [humanId, agentId]).catch(() => null), 30_000);
  check('the highlight is on the rewritten text, on its new page, in green',
    drawn?.hlPage === '4' && drawn.resolved && /somme partielle/.test(drawn.under) && !/blocs égaux/.test(drawn.under), JSON.stringify(drawn));
  check('a thin caret marks where the deleted passage was, on its new page',
    drawn?.caretPage === '5' && drawn.caretW > 0 && drawn.caretW < 8, JSON.stringify(drawn));
} catch (e) {
  check('the run completed', false, e?.stack ?? String(e));
} finally {
  await browser.close();
  await client.close();
}

const failed = checks.filter(([, ok]) => !ok).length;
console.log(failed ? `\nSMOKE FAIL: ${failed}` : '\nSMOKE PASS');
process.exit(failed ? 1 : 0);
