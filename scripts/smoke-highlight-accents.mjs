// A highlight must land on French text: accents, line breaks and hyphenation.
//
// Matching used to compare ASCII words only, so an accented letter was a word
// break ("été" → "t"): a highlight stopped short of an accented first or last
// letter, a quote in the other Unicode form than the PDF's never matched (and a
// reviewer comment, which has no stored rects, then showed nothing), and a
// quote across a hyphenated line break never matched either.
//
// It also checks the text layer itself is sized like the canvas glyphs: it
// used to be the browser's default 13px font, so a drag-selection didn't
// follow the text under the mouse.
//
// This drives the real workspace in a real browser, once with Unicode fonts (é
// is one glyph) and once with OT1 fonts (é is an e with a separate accent
// glyph), and compares each drawn highlight against the glyphs.
//
//   node scripts/smoke-highlight-accents.mjs
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const TOLERANCE_PX = 2;

// Starts on "é", ends on "é", and is long enough to wrap onto a second line.
const ACCENT_QUOTE = 'été très chaud dans la région, où les élèves ont préféré étudier à côté de la fenêtre ouverte pendant toute la journée passée';
// Ends on "à" + "é": the end edge is the one that used to be clipped.
const END_QUOTE = 'la fenêtre ouverte pendant toute la journée passée à l’université';

// The engine is XeLaTeX: by default (TU) é is one glyph; forcing OT1 draws it
// as an e plus a separate accent glyph, as pdfLaTeX without T1 does.
const tex = (ot1) => [
  String.raw`\documentclass{article}`,
  ...(ot1 ? [String.raw`\usepackage[OT1]{fontenc}`] : []),
  String.raw`\begin{document}`,
  String.raw`\section{Introduction}`,
  'Cette année, il a fait un été très chaud dans la région, où les élèves ont préféré étudier à côté de la fenêtre ouverte pendant toute la journée passée à l’université.',
  '',
  // A narrow paragraph full of long words, so TeX has to hyphenate some.
  String.raw`\parbox{4.2cm}{Les caractéristiques interdisciplinaires des représentations gouvernementales internationales nécessitent une compréhension extraordinairement approfondie.}`,
  '',
  'Du texte de remplissage pour que la page ait du contenu. '.repeat(20),
  String.raw`\end{document}`,
  '',
].join('\n');

const checks = [];
const check = (name, ok, detail) => { checks.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };

async function run(label, ot1, browser) {
  const proj = mkdtempSync(join(tmpdir(), 'magictex-accents-'));
  writeFileSync(join(proj, 'main.tex'), tex(ot1));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, join(REPO, 'src', 'server.ts')],
    cwd: proj,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'accents-smoke', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  try {
    const r = await client.callTool({ name: 'render_preview', arguments: { backend: 'wasm' } }, undefined, { timeout: 15 * 60 * 1000 });
    const out = r.content.map((c) => c.text ?? '').join('\n');
    const base = out.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (!base) { check(`${label}: workspace URL`, false, out.slice(0, 300)); return; }

    await page.goto(`${base}/app`, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForSelector('.page .textLayer span', { timeout: 60_000 });
    await page.waitForTimeout(500);

    // How pdf.js spelled the accents on this page — useful when a check fails.
    const sample = await page.evaluate(() => {
      const t = [...document.querySelectorAll('.page .textLayer span')].map((s) => s.textContent).join('|');
      const at = Math.max(0, t.search(/il a fait/));
      return JSON.stringify(t.slice(at, at + 40));
    });
    console.log(`  ${label} text layer: ${sample}`);

    // pdf.js only positions the spans; their size comes from CSS rules using
    // the variables it sets. Without those rules every span was the browser's
    // default font size, unstretched, so a drag-selection didn't follow the
    // glyphs. Each span's font size must be --font-height × the page scale.
    const sizing = await page.evaluate(() => {
      const pg = document.querySelector('.page');
      const scale = parseFloat(pg.style.getPropertyValue('--scale-factor')) || 1;
      let bad = 0, n = 0, stretched = 0;
      for (const el of pg.querySelectorAll('.textLayer span')) {
        const h = parseFloat(el.style.getPropertyValue('--font-height'));
        if (!h) continue;
        n++;
        if (Math.abs(parseFloat(getComputedStyle(el).fontSize) - h * scale) > 0.5) bad++;
        if (el.style.getPropertyValue('--scale-x') && getComputedStyle(el).transform !== 'none') stretched++;
      }
      return { n, bad, stretched };
    });
    check(`${label}: text layer is sized like the PDF glyphs`, sizing.n > 0 && sizing.bad === 0 && sizing.stretched > 0,
      `${sizing.bad}/${sizing.n} spans mis-sized, ${sizing.stretched} stretched`);

    // A hyphenated word in the PDF, e.g. "inter-" ⏎ "disciplinaires": build a
    // quote of the words around it with the word WHOLE, as the source has it.
    const hyph = await page.evaluate(() => {
      const spans = [...document.querySelectorAll('.page .textLayer span')];
      for (let i = 0; i < spans.length - 1; i++) {
        const a = spans[i].textContent ?? '';
        if (!/\p{L}-$/u.test(a)) continue;
        const next = spans.slice(i + 1).find((s) => (s.textContent ?? '').trim());
        if (!next) continue;
        const before = a.slice(0, -1).trim().split(/\s+/);
        const after = next.textContent.trim().split(/\s+/);
        const joined = before.pop() + after.shift();
        return [...before.slice(-2), joined, ...after.slice(0, 2)].join(' ');
      }
      return null;
    });
    check(`${label}: the PDF has a hyphenated line break to test`, !!hyph, hyph ?? '');

    const quotes = [['accented start+end', ACCENT_QUOTE], ['ends on accents', END_QUOTE]];
    if (hyph) quotes.push(['across hyphenation', hyph]);
    // Reviewer comments: no rects, so the highlight exists only if the quote is
    // found in the live text layer.
    const ids = {};
    for (const [name, q] of quotes) {
      const a = await client.callTool({ name: 'add_comment', arguments: { quote: q, comment: 'x', accepted: true } });
      ids[name] = a.content.map((c) => c.text ?? '').join('').match(/comment (\S+) posted/)?.[1];
    }
    await page.waitForTimeout(1500);

    const result = await page.evaluate(() => {
      const comments = [...document.querySelectorAll('.hl')].reduce((m, el) => {
        (m[el.dataset.id] ??= []).push(el.getBoundingClientRect());
        return m;
      }, {});
      // Where the highlight STARTS is the left of its top box; where it ends,
      // the right of its bottom box (the lines between are full width).
      return Object.fromEntries(Object.entries(comments).map(([id, rs]) => {
        const byTop = [...rs].sort((a, b) => a.top - b.top);
        return [id, { boxes: rs.length, left: byTop[0].left, right: byTop[byTop.length - 1].right }];
      }));
    });
    for (const [name] of quotes) check(`${label}: "${name}" quote is highlighted`, !!result[ids[name]]);

    // Ground truth for the edges: the glyphs of the quote's first and last
    // letters, found by searching the text layer in NFC with accent glyphs
    // dropped (so it works for both font encodings).
    const edges = await page.evaluate(([first, last]) => {
      const clean = (s) => s.normalize('NFD').replace(/[̀-ͯ´¨ˆˇ˘-˝`¸]/g, '');
      const out = {};
      for (const el of document.querySelectorAll('.page .textLayer span')) {
        const node = el.firstChild;
        if (!node || node.nodeType !== Node.TEXT_NODE) continue;
        const raw = node.textContent;
        // Index in raw of the k-th kept char, mirroring clean().
        const keep = [];
        for (let i = 0; i < raw.length; i++) if (clean(raw[i])) keep.push(i);
        const c = [...raw].map((ch) => clean(ch)).join('');
        const a = c.indexOf(first);
        if (a >= 0 && out.left === undefined) { const rg = document.createRange(); rg.setStart(node, keep[a]); rg.setEnd(node, keep[a] + 1); out.left = rg.getBoundingClientRect().left; }
        const b = c.indexOf(last);
        if (b >= 0 && out.right === undefined) { const k = keep[b + last.length - 1]; const rg = document.createRange(); rg.setStart(node, k); rg.setEnd(node, k + 1); out.right = rg.getBoundingClientRect().right; }
      }
      return out;
    }, ['ete tres chaud', 'universite']);

    if (edges?.left === undefined || edges?.right === undefined) console.log(`  ${label}: glyph edges not measurable: ${JSON.stringify(edges)}`);
    const startHl = result[ids['accented start+end']];
    if (edges?.left !== undefined && startHl) {
      const off = startHl.left - edges.left;
      check(`${label}: highlight starts on the "é" of "été", not after it`, Math.abs(off) <= TOLERANCE_PX, `${off.toFixed(1)}px off`);
    }
    const endHl = result[ids['ends on accents']];
    if (edges?.right !== undefined && endHl) {
      const off = endHl.right - edges.right;
      check(`${label}: highlight ends on the final "é" of "université"`, Math.abs(off) <= TOLERANCE_PX, `${off.toFixed(1)}px off`);
    }
    if (hyph) check(`${label}: hyphenated quote spans its two lines`, (result[ids['across hyphenation']]?.boxes ?? 0) >= 2);

    // The agent loop is told where each quote lives in the source.
    const cc = (await client.callTool({ name: 'check_comments', arguments: {} })).content.map((c) => c.text ?? '').join('\n');
    const anchored = (cc.match(/source: main\.tex:\d+/g) ?? []).length;
    check(`${label}: every quote is located in main.tex`, anchored === quotes.length, `${anchored}/${quotes.length}`);
  } finally {
    await page.close();
    await client.close();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  await run('TU', false, browser);
  await run('OT1', true, browser);
} finally {
  await browser.close();
}

console.log('');
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
const failed = checks.filter(([, ok]) => !ok);
console.log(failed.length ? `\nSMOKE FAIL: ${failed.length}` : '\nSMOKE PASS');
process.exit(failed.length ? 1 : 0);
