// Zooming the PDF must actually resize the pages — from the toolbar, from
// Ctrl+wheel / a trackpad pinch, and after the server has gone away.
//
// Three ways it used to fail, all with the % label happily changing:
//   - every zoom step re-downloaded /latest.pdf before redrawing, so a window
//     whose server had stopped (its Claude session ended) kept the old pages;
//   - Ctrl+wheel was not handled, so the browser zoomed the whole workspace;
//   - pages were centred with `align-items: center`, so once a page was wider
//     than the pane its left part overflowed where no scrollbar reaches.
//
// This drives the real workspace in a real browser and measures the pages.
//
//   node scripts/smoke-zoom.mjs
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

// Several pages, so a redraw is a real loop and not a single canvas.
const proj = mkdtempSync(join(tmpdir(), 'magictex-zoomctl-'));
writeFileSync(join(proj, 'main.tex'), [
  String.raw`\documentclass{article}`,
  String.raw`\begin{document}`,
  ...[1, 2, 3].map((n) => String.raw`\section{Part ${n}}` + '\n' + 'Some words to give the text layer something to lay out. '.repeat(30) + '\n' + String.raw`\newpage`),
  String.raw`\end{document}`,
  '',
].join('\n'));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, join(REPO, 'src', 'server.ts')],
  cwd: proj,
  stderr: 'ignore',
});
const client = new Client({ name: 'zoom-controls-smoke', version: '0' }, { capabilities: {} });
await client.connect(transport);

const r = await client.callTool({ name: 'render_preview', arguments: { backend: 'wasm' } }, undefined, { timeout: 15 * 60 * 1000 });
const out = r.content.map((c) => c.text ?? '').join('\n');
const base = out.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
if (!base) { console.error('no workspace URL:\n' + out.slice(0, 400)); process.exit(1); }

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const checks = [];
const check = (name, ok, detail) => { checks.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };

// Which point of which page sits under a pane position, in scale-1 units, so
// "zoom kept the cursor's spot still" can be checked across a redraw.
const pointUnder = (vx, vy) => page.evaluate(([vx, vy]) => {
  const scroller = document.querySelector('.pdf-scroll');
  const r = scroller.getBoundingClientRect();
  const x = r.left + vx, y = r.top + vy;
  for (const el of document.querySelectorAll('.page')) {
    const p = el.getBoundingClientRect();
    if (y >= p.top && y <= p.bottom) {
      const s = parseFloat(el.style.getPropertyValue('--scale-factor'));
      return { page: el.dataset.page, x: (x - p.left) / s, y: (y - p.top) / s, s };
    }
  }
  return null;
}, [vx, vy]);
// Drift on screen, in px at the new scale.
const drift = (a, b) => (a && b && a.page === b.page) ? Math.hypot(a.x - b.x, a.y - b.y) * b.s : Infinity;

const pageWidth = () => page.evaluate(() => parseFloat(document.querySelector('.page')?.style.width ?? '0'));
// A redraw swaps every page in at once, so poll for the width to move.
const widthAfter = async (before, ms = 10_000) => {
  const until = Date.now() + ms;
  let w = before;
  while (Date.now() < until) {
    w = await pageWidth();
    if (Math.abs(w - before) > 1) return w;
    await page.waitForTimeout(100);
  }
  return w;
};

// Fit to width, for room to zoom in after checks that went near the limit.
const fitWidth = async () => {
  const w = await pageWidth();
  await page.click('.pdf-toolbar .zoom-val');
  await widthAfter(w);
};

let closed = false;
try {
  await page.goto(`${base}/app`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('.page canvas', { timeout: 60_000 });

  // 1. The toolbar, against a live server — the case CI always covered. It
  //    keeps the middle of the pane on the same spot of the page.
  {
    await page.evaluate(() => { document.querySelector('.pdf-scroll').scrollTop = 300; });
    const pane = await page.locator('.pdf-scroll').boundingBox();
    const mid = [pane.width / 2, pane.height / 2];
    const spot = await pointUnder(...mid);
    const before = await pageWidth();
    await page.click('.pdf-toolbar button[title="Zoom in"]');
    const after = await widthAfter(before);
    await page.waitForTimeout(200);
    check('+ resizes the pages', after > before, `${before}px → ${after}px`);
    const d = drift(spot, await pointUnder(...mid));
    check('+ keeps the middle of the pane still', d < 3, `moved ${d.toFixed(1)}px`);
  }

  // 2. Ctrl+wheel over the PDF zooms the PDF, and the browser's own zoom is
  //    suppressed. Whether the event was claimed is read from a window-level
  //    listener, which runs after the pane's own handler.
  {
    await page.evaluate(() => {
      window.__wheel = [];
      window.addEventListener('wheel', (e) => { if (e.ctrlKey) window.__wheel.push(e.defaultPrevented); });
    });
    const box = await page.locator('.pdf-scroll').boundingBox();
    // Off-centre on purpose: the spot under the cursor, not the pane's middle,
    // is what must stay still.
    const at = [box.width * 0.3, box.height * 0.4];
    await page.mouse.move(box.x + at[0], box.y + at[1]);
    const spot = await pointUnder(...at);
    const before = await pageWidth();
    await page.keyboard.down('Control');
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    const after = await widthAfter(before);
    const claimed = await page.evaluate(() => window.__wheel.length > 0 && window.__wheel.every(Boolean));
    check('Ctrl+wheel resizes the pages', after > before, `${before}px → ${after}px`);
    check('Ctrl+wheel does not reach the browser', claimed);
    await page.waitForTimeout(200);
    const d = drift(spot, await pointUnder(...at));
    check('Ctrl+wheel keeps the spot under the cursor still', d < 3, `moved ${d.toFixed(1)}px`);
  }

  // 3. A normal scroll right after a Ctrl+wheel is kept: the redraw anchors on
  //    what is under the cursor when it lands, not where the zoom began.
  {
    const box = await page.locator('.pdf-scroll').boundingBox();
    const at = [box.width * 0.5, box.height * 0.3];
    await page.mouse.move(box.x + at[0], box.y + at[1]);
    const before = await pageWidth();
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    const top0 = await page.evaluate(() => document.querySelector('.pdf-scroll').scrollTop);
    await page.mouse.wheel(0, 300);
    // What the reader sees under the cursor after scrolling, through the preview.
    let seen = null;
    for (let i = 0; i < 20 && !seen; i++) {
      seen = await page.evaluate(([vx, vy, top0]) => {
        const scroller = document.querySelector('.pdf-scroll');
        if (scroller.scrollTop === top0 || !document.querySelector('.pdf-pages').style.transform) return null;
        const r = scroller.getBoundingClientRect();
        const x = r.left + vx, y = r.top + vy;
        for (const el of document.querySelectorAll('.page')) {
          const p = el.getBoundingClientRect(); // includes the preview stretch
          if (y >= p.top && y <= p.bottom) {
            const shown = p.width / parseFloat(el.style.width) * parseFloat(el.style.getPropertyValue('--scale-factor'));
            return { page: el.dataset.page, x: (x - p.left) / shown, y: (y - p.top) / shown };
          }
        }
        return null;
      }, [...at, top0]);
      if (!seen) await page.waitForTimeout(10);
    }
    await widthAfter(before);
    await page.waitForTimeout(200);
    const after = await pointUnder(...at);
    if (!seen) check('a scroll during a zoom is kept', false, 'the scroll did not happen inside the preview window');
    else {
      const d = drift(seen, after);
      check('a scroll during a zoom is kept', d < 4, `the spot scrolled to moved ${d.toFixed(1)}px when the redraw landed`);
    }
  }

  // 4. Text selected during a zoom preview is stored where it is on the page.
  {
    await fitWidth();
    const box = await page.locator('.pdf-scroll').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // One synchronous step: start a preview, select a span, release the mouse
    // — the comment composer captures its rects while the pages are stretched.
    const picked = await page.evaluate(() => {
      const scroller = document.querySelector('.pdf-scroll');
      const r = scroller.getBoundingClientRect();
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
      // Only a real stretch tests anything: scale(1) divides out either way.
      const t = document.querySelector('.pdf-pages').style.transform;
      const stretched = /scale\(([\d.]+)\)/.test(t) && Math.abs(parseFloat(t.slice(6)) - 1) > 0.05 ? t : '';
      const pg = [...document.querySelectorAll('.page')].find((el) => { const b = el.getBoundingClientRect(); return b.bottom > r.top && b.top < r.bottom; });
      const spans = [...pg.querySelectorAll('.textLayer span')];
      const idx = spans.findIndex((sp) => (sp.textContent ?? '').trim().length > 20);
      const range = document.createRange();
      range.selectNodeContents(spans[idx].firstChild);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      scroller.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return { page: pg.dataset.page, idx, stretched };
    });
    await page.fill('.composer textarea', 'rect check');
    await page.click('.composer button:has-text("Add comment")');
    await page.waitForTimeout(1500); // let the preview commit and redraw
    const stored = (await (await fetch(`${base}/api/comments`)).json()).find((c) => c.text === 'rect check');
    // Ground truth, once nothing is stretched: the same span, in scale-1 units.
    const truth = await page.evaluate(({ page: n, idx }) => {
      const pg = document.querySelector(`.page[data-page="${n}"]`);
      const sp = pg.querySelectorAll('.textLayer span')[idx];
      const range = document.createRange();
      range.selectNodeContents(sp.firstChild);
      const r = range.getBoundingClientRect(), p = pg.getBoundingClientRect();
      const s = parseFloat(pg.style.getPropertyValue('--scale-factor'));
      return { x: (r.left - p.left) / s, y: (r.top - p.top) / s, transform: document.querySelector('.pdf-pages').style.transform };
    }, picked);
    const got = stored?.rects?.[0];
    const off = got ? Math.hypot(got.x - truth.x, got.y - truth.y) : Infinity;
    check('a selection made during a zoom preview is stored in place', !!picked.stretched && off < 1.5,
      picked.stretched ? `stored ${off.toFixed(2)} units from the text` : 'no preview was active when selecting');
  }

  // 5. A redraw that fails mid-zoom leaves no stretched preview behind, and the
  //    next zoom still works.
  {
    await fitWidth();
    const box = await page.locator('.pdf-scroll').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const before = await pageWidth();
    await page.evaluate(() => {
      window.__getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = () => { throw new Error('smoke: canvas refused'); };
    });
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await page.waitForSelector('.pdf-note-report', { timeout: 10_000 }).catch(() => {});
    const stuck = await page.evaluate(() => {
      const pages = document.querySelector('.pdf-pages');
      const p = document.querySelector('.page');
      return { transform: pages.style.transform, ratio: p.getBoundingClientRect().width / parseFloat(p.style.width), report: !!document.querySelector('.pdf-note-report') };
    });
    check('a failed redraw does not leave the zoom preview stretched', stuck.report && !stuck.transform && Math.abs(stuck.ratio - 1) < 0.01,
      `report shown: ${stuck.report}, transform "${stuck.transform}", page drawn ×${stuck.ratio.toFixed(3)}`);
    await page.evaluate(() => { HTMLCanvasElement.prototype.getContext = window.__getContext; });
    await page.click('.pdf-toolbar button[title="Zoom in"]');
    const after = await widthAfter(before);
    check('zoom works again after a failed redraw', after > before, `${before}px → ${after}px`);
  }

  // 6. A page wider than the pane can be scrolled to its left edge.
  {
    for (let i = 0; i < 30; i++) {
      const btn = page.locator('.pdf-toolbar button[title="Zoom in"]');
      if (await btn.isDisabled()) break;
      const before = await pageWidth();
      await btn.click();
      await widthAfter(before);
    }
    const geo = await page.evaluate(() => {
      const scroller = document.querySelector('.pdf-scroll');
      scroller.scrollLeft = 0;
      const p = document.querySelector('.page').getBoundingClientRect();
      const s = scroller.getBoundingClientRect();
      return { pageLeft: p.left, paneLeft: s.left, pageW: p.width, paneW: s.width };
    });
    check('a wide page is reachable at its left edge', geo.pageW > geo.paneW && geo.pageLeft >= geo.paneLeft - 1,
      `page ${Math.round(geo.pageW)}px in a ${Math.round(geo.paneW)}px pane, left edge ${Math.round(geo.pageLeft - geo.paneLeft)}px from the pane's`);
  }

  // 7. Once the server has stopped, zoom still works on what is on screen.
  {
    await client.close();
    closed = true;
    await page.waitForSelector('text=has stopped', { timeout: 15_000 }).catch(() => {});
    const before = await pageWidth();
    await page.click('.pdf-toolbar button[title="Zoom out"]');
    const after = await widthAfter(before);
    check('− resizes the pages after the server stopped', after > 0 && after < before, `${before}px → ${after}px`);
  }
} finally {
  await browser.close();
  if (!closed) await client.close();
}

const failed = checks.filter(([, ok]) => !ok);
console.log(failed.length ? `\nSMOKE FAIL: ${failed.length}` : '\nSMOKE PASS');
process.exit(failed.length ? 1 : 0);
