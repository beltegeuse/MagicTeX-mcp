// Center panel: renders /latest.pdf with pdf.js (canvas + selectable text
// layer), re-renders on WS reload, and hosts the LiquidText-style interaction:
// select text on a page → floating "Comment" composer → anchored highlight.
// A control strip provides Overleaf-style zoom + page navigation; the render
// scale is state, and highlights are stored at scale 1 and projected by it.
import { useCallback, useEffect, useRef, useState } from 'react';
import '../mathSumPrecise'; // must precede pdfjs — see the file for why
import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { createComment, type Comment } from '../api';
import { fold, findHead, occurrenceOn, CONTEXT_CHARS, stripLatex } from '../sync';
import { groupLines, columnsFromTextItems } from '../lines';

// Our own worker module: it installs the Math.sumPrecise polyfill into the
// worker's global before loading pdf.js's worker. Patching the main thread
// alone leaves the font/layout half of pdf.js still calling a method Safari
// does not have, which blanked the PDF pane.
//
// But `workerPort` is not a drop-in for `workerSrc`. Inside pdf.js, the
// workerSrc path (#initialize) wraps worker creation in try/catch, registers an
// 'error' listener, and falls back to #setupFakeWorker() — running the parser on
// the main thread — if anything goes wrong. The workerPort path
// (#initializeFromPort) does none of that: it attaches a message handler and
// resolves. So a worker that fails to start left `getDocument().promise`
// permanently unsettled: no pages, no error, and the render pane stuck on
// "waiting for first compile…" forever. Strictly worse than the bare message the
// diagnostics work set out to improve.
//
// So the fallback is rebuilt here. Construction is wrapped, and an 'error' from
// the worker hands pdf.js back its own workerSrc path, which brings its fake
// worker with it — and the main thread already has the polyfill installed by the
// import above, so the fallback is not the broken configuration either.
try {
  const worker = new Worker(new URL('../pdfWorker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('error', (e) => {
    console.error('[MagicTeX] the pdf.js worker failed to start; falling back to pdf.js\'s own worker', e);
    pdfjs.GlobalWorkerOptions.workerPort = null;
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  });
  pdfjs.GlobalWorkerOptions.workerPort = worker;
} catch (e) {
  // A CSP that blocks worker-src, or any environment without `Worker`. Throwing
  // here would take the whole app down, because this runs at module scope on an
  // import App.tsx makes unconditionally — a blank workspace instead of a blank
  // PDF pane.
  console.error('[MagicTeX] could not construct the pdf.js worker; using pdf.js\'s own', e);
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
}

const MIN_SCALE = 0.4;
const MAX_SCALE = 3;
// Ctrl+wheel: one mouse-wheel notch (deltaY 100) zooms by about 16%; a
// trackpad pinch sends many small deltas and so zooms smoothly.
const WHEEL_ZOOM_RATE = 0.0015;
// Firefox reports a notch in lines (3 of them) rather than pixels; a third of a
// Chrome notch per line makes the two browsers zoom alike.
const WHEEL_LINE_PX = 100 / 3;
// How long a wheel gesture must pause before the pages are redrawn at its scale.
const WHEEL_SETTLE_MS = 150;

/** The scale a `.page` was drawn at, as the renderer recorded it on the page. */
const pageScale = (el: HTMLElement) => parseFloat(el.style.getPropertyValue('--scale-factor')) || 1;
// A page's text-layer spans in reading order — only the ones holding text, so a
// marked-content wrapper span doesn't count its children's text a second time.
const textSpans = (page: Element) =>
  (Array.from(page.querySelectorAll('.textLayer span')) as HTMLElement[]).filter((s) => !s.firstElementChild);

interface Draft {
  page: number; quote: string; rects: { x: number; y: number; w: number; h: number }[]; x: number; y: number;
  prefix: string; suffix: string;
}
interface SyncTarget { text: string; nonce: number }
/** A point on a page (scale-1 units) and the pane position (px) it should sit at. */
interface Anchor { page: string; ax: number; ay: number; vx: number; vy: number }
/**
 * A Ctrl+wheel / pinch zoom in progress: the pane position it is anchored at,
 * the scale it is heading for, and the preview stretch currently applied —
 * `scale(k)` about `origin`, in `.pdf-pages` coordinates; origin null = none yet.
 */
interface Gesture { vx: number; vy: number; pending: number; origin: { x: number; y: number } | null; k: number }
/** Safari's pinch event (non-standard, so not in lib.dom). */
interface SafariGestureEvent extends UIEvent { scale: number; clientX: number; clientY: number }

export function PdfView({
  reloadTick, comments, onPages, onSelectComment, onSyncToSource, syncTarget,
}: {
  reloadTick: number;
  comments: Comment[];
  onPages?: (n: number) => void;
  onSelectComment?: (id: string) => void;
  onSyncToSource?: (text: string) => void;
  syncTarget?: SyncTarget | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState<string>('waiting for first compile…');
  // A note is either prose for the reader or a failure report to be copied out.
  // They want opposite typography, so the pane needs to know which it is holding.
  const [noteIsReport, setNoteIsReport] = useState(false);
  const [renderTick, setRenderTick] = useState(0); // bumps after pages exist in the DOM
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftText, setDraftText] = useState('');
  const [scale, setScale] = useState(1.5);
  // The scale a Ctrl+wheel / pinch gesture is heading for, before it is
  // committed. The label shows it at once; the pages follow when it settles.
  const [preview, setPreview] = useState<number | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const baseWidth = useRef(0); // page-1 width at scale 1, for fit-to-width
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  // The parsed PDF is kept between renders, so a zoom redraws from memory.
  // Zoom used to re-download /latest.pdf on every step: a window whose server
  // had stopped — its Claude session ended — kept its old pages while the %
  // label moved, which read as "zoom does nothing".
  const docRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  const [docTick, setDocTick] = useState(0); // bumps when docRef holds a new document
  const renderedScale = useRef(0); // the scale of the pages currently in the DOM
  // Column boundaries per page, as stored on `.page`. They are in scale-1 units,
  // so they hold for every zoom of a document; recomputing them made each zoom
  // fetch every page's text content a second time.
  const columnsCache = useRef<{ doc: pdfjs.PDFDocumentProxy | null; byPage: Map<number, string> }>({ doc: null, byPage: new Map() });
  const gestureRef = useRef<Gesture | null>(null);

  // A failure report someone can screenshot. A screenshot is what actually
  // reaches a maintainer, so it has to carry enough on its own — which step,
  // which browser, which pdf.js. The console gets the error object itself, so
  // DevTools can offer a real clickable stack.
  const reportFailure = (step: string, e: unknown) => {
    console.error('[MagicTeX] PDF render failed during: ' + step, e);
    const err = e as { message?: string; stack?: string; name?: string };
    // pdf.js re-creates worker exceptions on this side of a postMessage, and a
    // stack does not survive that trip — so for the errors most worth
    // diagnosing there is nothing to print. Say so, rather than leaving a gap
    // that reads like the report simply forgot: "no stack" is itself the clue
    // that the failure happened inside the worker, not in this file.
    const stack = err?.stack
      ? '\n' + err.stack.split('\n').slice(0, 6).join('\n')
      : '\n(no stack — the error crossed the pdf.js worker boundary, which does not carry one)';
    setNoteIsReport(true);
    setNote(
      `render failed while ${step}\n\n${err?.name ?? 'Error'}: ${err?.message ?? String(e)}${stack}` +
      `\n\npdf.js ${pdfjs.version} · ${navigator.userAgent}`,
    );
  };

  // The point of the pages under a pane position (px from the pane's corner),
  // as an anchor. Measured in layout (offsets), with the preview stretch undone:
  // a point seen at V under scale(k) about O sits at O + (V − O) / k.
  const captureAnchor = (vx: number, vy: number): Anchor | null => {
    const scroller = scrollRef.current;
    const pages = pagesRef.current;
    const s = renderedScale.current;
    if (!scroller || !pages || !s) return null;
    let px = scroller.scrollLeft + vx - pages.offsetLeft;
    let py = scroller.scrollTop + vy - pages.offsetTop;
    const g = gestureRef.current;
    if (g?.origin && g.k !== 1) {
      px = g.origin.x + (px - g.origin.x) / g.k;
      py = g.origin.y + (py - g.origin.y) / g.k;
    }
    const x = px + pages.offsetLeft;
    const y = py + pages.offsetTop;
    let hit: HTMLElement | null = null;
    for (const el of pagesRef.current?.querySelectorAll<HTMLElement>('.page') ?? []) {
      if (!hit || el.offsetTop <= y) hit = el;
      else break;
    }
    if (!hit) return null;
    return { page: hit.dataset.page ?? '1', ax: (x - hit.offsetLeft) / s, ay: (y - hit.offsetTop) / s, vx, vy };
  };
  const restoreAnchor = (a: Anchor, s: number) => {
    const scroller = scrollRef.current;
    const el = pagesRef.current?.querySelector<HTMLElement>(`.page[data-page="${a.page}"]`);
    if (!scroller || !el) return;
    scroller.scrollLeft = el.offsetLeft + a.ax * s - a.vx;
    scroller.scrollTop = el.offsetTop + a.ay * s - a.vy;
  };
  // Stretch the pages already on screen towards the gesture's scale, around
  // the point under its anchor, until the real redraw lands. The origin is
  // fixed when the stretch starts: recomputing it from the scroll position on
  // every event moved the zoom point whenever that position changed under it.
  const applyPreview = (g: Gesture) => {
    const scroller = scrollRef.current;
    const pages = pagesRef.current;
    if (!scroller || !pages || !renderedScale.current) return;
    g.origin ??= { x: scroller.scrollLeft + g.vx - pages.offsetLeft, y: scroller.scrollTop + g.vy - pages.offsetTop };
    g.k = g.pending / renderedScale.current;
    pages.style.transformOrigin = `${g.origin.x}px ${g.origin.y}px`;
    pages.style.transform = `scale(${g.k})`;
  };
  const clearPreview = () => {
    const pages = pagesRef.current;
    if (pages) { pages.style.transform = ''; pages.style.transformOrigin = ''; }
    setPreview(null);
  };

  // ── Load /latest.pdf (on every reload) ─────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    // What the load was doing when it threw. A rendering failure reported as
    // bare `String(e)` cost three rounds of guessing on a real bug: the message
    // "TypeError: undefined is not a function (near '...e of t...')" named no
    // page, no step and no stack, so every reading of it was a guess. Whatever
    // fails next should say where.
    let step = 'fetching /latest.pdf';
    (async () => {
      const res = await fetch('/latest.pdf?t=' + Date.now());
      if (!res.ok) { setNoteIsReport(false); setNote('No PDF yet — ask Claude to render a preview.'); return; }
      const data = new Uint8Array(await res.arrayBuffer());
      step = `parsing PDF (${data.length} bytes)`;
      const doc = await pdfjs.getDocument({ data }).promise;
      if (cancelled) return;
      docRef.current = doc;
      setDocTick((t) => t + 1);
    })().catch((e) => {
      if (cancelled) { console.warn('[MagicTeX] superseded load failed during: ' + step, e); return; }
      reportFailure(step, e);
    });
    return () => { cancelled = true; };
  }, [reloadTick]);

  // ── Render PDF pages (canvas + text layer) ──────────────────────────────
  useEffect(() => {
    const doc = docRef.current;
    if (!doc) return;
    let cancelled = false;
    let step = 'starting';
    const renderScale = scaleRef.current;
    (async () => {
      const container = pagesRef.current;
      const scroller = scrollRef.current;
      if (!container || !scroller) return;
      if (columnsCache.current.doc !== doc) columnsCache.current = { doc, byPage: new Map() };
      const columns = columnsCache.current.byPage;
      // Render every page off-screen, then swap in at once — no blank flash.
      const next = document.createDocumentFragment();
      for (let i = 1; i <= doc.numPages; i++) {
        step = `page ${i}/${doc.numPages}: getPage`;
        const pg = await doc.getPage(i);
        if (cancelled) return;
        if (i === 1) baseWidth.current = pg.getViewport({ scale: 1 }).width;
        const vp = pg.getViewport({ scale: renderScale });
        const wrap = document.createElement('div');
        wrap.className = 'page';
        wrap.dataset.page = String(i);
        wrap.style.width = `${vp.width}px`;
        wrap.style.height = `${vp.height}px`;
        wrap.style.setProperty('--scale-factor', String(renderScale));
        // The text layer's CSS sizes spans by scale × user unit, as the canvas is.
        wrap.style.setProperty('--user-unit', String(vp.userUnit ?? 1));
        const canvas = document.createElement('canvas');
        canvas.width = vp.width;
        canvas.height = vp.height;
        wrap.appendChild(canvas);
        const textDiv = document.createElement('div');
        textDiv.className = 'textLayer';
        wrap.appendChild(textDiv);
        const hlDiv = document.createElement('div');
        hlDiv.className = 'hl-layer';
        wrap.appendChild(hlDiv);
        next.appendChild(wrap);
        // pdf.js v5 made `canvas` the required parameter and demoted
        // `canvasContext` to a back-compat alias, so pass the element.
        step = `page ${i}/${doc.numPages}: canvas render`;
        await pg.render({ canvas, viewport: vp }).promise;
        step = `page ${i}/${doc.numPages}: text layer`;
        const textLayer = new pdfjs.TextLayer({ textContentSource: pg.streamTextContent(), container: textDiv, viewport: vp });
        await textLayer.render();
        // Column boundaries come from the PDF's own coordinates, not from the
        // rendered text layer. That layer is an approximation which degrades at
        // small font sizes — spans overflow into their neighbours and fill the
        // gutter — so detecting columns from the DOM answered differently at
        // each zoom of the same document: two boundaries at 150%, one at 124%,
        // none at 102%, at which point a highlight spanned the whole page.
        // Computed once per page in scale-1 units, projected where it's used.
        //
        // Wrapped, and deliberately: this is an input to highlight placement, not
        // to rendering. Shipped without the guard it threw on a document whose
        // text content carries entries with no `str` — pdf.js mixes marked-content
        // markers in among the text items — and took the whole PDF pane down with
        // it. A worse failure than the misplaced highlight it was added to fix.
        // Without boundaries the grouping falls back to inferring them, which is
        // what every release before this one did.
        //
        // `step` is still set inside the guard. Nothing here can reach the outer
        // report any more, but the warning below is the only trace a skipped page
        // leaves, and "which page, at which stage" is the part worth having in it.
        step = `page ${i}/${doc.numPages}: column detection`;
        const known = columns.get(i);
        if (known !== undefined) wrap.dataset.columns = known;
        else {
          try {
            const content = await pg.getTextContent();
            const cols = JSON.stringify(columnsFromTextItems(content.items, pg.getViewport({ scale: 1 }).height));
            wrap.dataset.columns = cols;
            columns.set(i, cols);
          } catch (e) {
            console.warn(`[magictex] column detection skipped — ${step}`, e);
          }
        }
      }
      if (cancelled) return;
      // Where to put the view, read off the old pages at the last moment, so a
      // scroll made while this was drawing is kept rather than undone. A zoom
      // keeps the point under the gesture's cursor (or the pane's middle, for
      // the buttons) still; a reload at the same scale keeps the scroll ratio.
      const g = gestureRef.current;
      const zoomed = !!renderedScale.current && renderedScale.current !== renderScale;
      const anchor = g ? captureAnchor(g.vx, g.vy)
        : zoomed ? captureAnchor(scroller.clientWidth / 2, scroller.clientHeight / 2) : null;
      const ratio = scroller.scrollHeight ? scroller.scrollTop / scroller.scrollHeight : 0;
      container.replaceChildren(next);
      renderedScale.current = renderScale;
      container.style.transform = '';
      container.style.transformOrigin = '';
      setNote('');
      setNumPages(doc.numPages);
      onPages?.(doc.numPages);
      setRenderTick((t) => t + 1);
      if (anchor) restoreAnchor(anchor, renderScale);
      else scroller.scrollTop = ratio * scroller.scrollHeight;
      if (g) {
        // The gesture went on while this redraw was running: keep previewing
        // what it is heading for, stretched from the new pages. Its own commit
        // follows. (Highlights are measured with the stretch taken off.)
        if (Math.abs(g.pending - renderScale) > 1e-3) { g.origin = null; applyPreview(g); }
        else { gestureRef.current = null; setPreview(null); }
      }
    })().catch((e) => {
      // A superseded run must not speak. Every other exit in this effect is gated
      // on `cancelled`; the catch was not, so a run abandoned by a zoom click or
      // a reload could reject AFTER a newer run had rendered fine and paint a
      // full failure report over it — styled, deliberately, to be screenshotted
      // into a bug report. The reporting work manufacturing false reports.
      if (cancelled) { console.warn('[MagicTeX] superseded render failed during: ' + step, e); return; }
      // The old pages stay up; a zoom preview stretched over them must not.
      gestureRef.current = null;
      clearPreview();
      reportFailure(step, e);
    });
    return () => { cancelled = true; };
  }, [docTick, scale, onPages]);

  // ── Ctrl+wheel / trackpad pinch zooms the PDF, not the browser ──────────
  // Native listeners because React registers wheel handlers as passive, and a
  // passive listener cannot stop the browser zooming the whole workspace.
  // Chrome, Edge and Firefox report a trackpad pinch as a wheel event with
  // ctrlKey set; Safari sends its own gesture events instead.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let timer = 0;
    const begin = (clientX: number, clientY: number): Gesture | null => {
      if (!renderedScale.current) return null;
      if (gestureRef.current) return gestureRef.current;
      const r = scroller.getBoundingClientRect();
      return (gestureRef.current = { vx: clientX - r.left, vy: clientY - r.top, pending: scaleRef.current, origin: null, k: 1 });
    };
    const update = (g: Gesture, next: number) => {
      g.pending = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
      setPreview(g.pending);
      applyPreview(g);
    };
    // Redrawing every page per wheel tick would never keep up: commit once
    // the gesture pauses, and let the preview carry it until then.
    const commit = () => {
      const cur = gestureRef.current;
      if (!cur) return;
      const target = +cur.pending.toFixed(3);
      if (Math.abs(target - scaleRef.current) < 1e-3) {
        // Back where it started (or pinned at a limit): nothing to redraw.
        if (Math.abs(target - renderedScale.current) < 1e-3) { gestureRef.current = null; clearPreview(); }
        return;
      }
      setScale(target);
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const g = begin(e.clientX, e.clientY);
      if (!g) return;
      const dy = e.deltaMode === 1 ? e.deltaY * WHEEL_LINE_PX : e.deltaMode === 2 ? e.deltaY * scroller.clientHeight : e.deltaY;
      update(g, g.pending * Math.exp(-dy * WHEEL_ZOOM_RATE));
      clearTimeout(timer);
      timer = window.setTimeout(commit, WHEEL_SETTLE_MS);
    };
    // Safari: `scale` is relative to where the pinch began, so keep that base.
    let pinchBase = 0;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      const ge = e as SafariGestureEvent;
      pinchBase = begin(ge.clientX, ge.clientY)?.pending ?? 0;
      clearTimeout(timer);
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = gestureRef.current;
      if (g && pinchBase) update(g, pinchBase * (e as SafariGestureEvent).scale);
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      pinchBase = 0;
      clearTimeout(timer);
      commit();
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });
    scroller.addEventListener('gesturestart', onGestureStart, { passive: false });
    scroller.addEventListener('gesturechange', onGestureChange, { passive: false });
    scroller.addEventListener('gestureend', onGestureEnd, { passive: false });
    return () => {
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('gesturestart', onGestureStart);
      scroller.removeEventListener('gesturechange', onGestureChange);
      scroller.removeEventListener('gestureend', onGestureEnd);
      clearTimeout(timer);
    };
  }, []);

  // ── Track which page is in view (for the page indicator) ────────────────
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const mid = scroller.scrollTop + scroller.clientHeight / 2;
        let best = 1;
        for (const page of pagesRef.current?.querySelectorAll('.page') ?? []) {
          const el = page as HTMLElement;
          if (el.offsetTop <= mid) best = Number(el.dataset.page);
        }
        setCurrentPage(best);
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => { scroller.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); };
  }, [renderTick]);

  // Button zooms keep the middle of the pane still (see the render's anchor).
  const zoomTo = (s: number) => {
    const target = Math.min(MAX_SCALE, Math.max(MIN_SCALE, +s.toFixed(3)));
    if (target !== scaleRef.current) setScale(target);
  };
  const zoomBy = (f: number) => zoomTo(scaleRef.current * f);
  const fitWidth = () => {
    const scroller = scrollRef.current;
    if (!scroller || !baseWidth.current) return;
    zoomTo((scroller.clientWidth - 40) / baseWidth.current);
  };
  const goToPage = (n: number) => {
    const p = Math.min(Math.max(1, n), numPages || 1);
    pagesRef.current?.querySelector(`.page[data-page="${p}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // ── Click a word (no selection) → jump to that text in the source ───────
  const onClick = (e: React.MouseEvent) => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // a drag-select is a comment, not a sync
    const span = (e.target as HTMLElement).closest('.textLayer span') as HTMLElement | null;
    if (!span || !onSyncToSource) return;
    let text = span.textContent ?? '';
    let n = span.nextElementSibling;
    while (n && fold(text).text.length < 48) { // ~8 words: enough to be distinctive
      text += ' ' + (n.textContent ?? '');
      n = n.nextElementSibling;
    }
    if (fold(text).text) onSyncToSource(text);
  };

  // ── Source → PDF: scroll the matching page/word into view and flash it ──
  useEffect(() => {
    const container = pagesRef.current;
    if (!container || !syncTarget) return;
    // The source side sends a raw LaTeX line; compare only the prose it prints.
    const target = fold(stripLatex(syncTarget.text)).text;
    if (target.length < 4) return;
    const pages = Array.from(container.querySelectorAll('.page')).map((page) => {
      let concat = '';
      const owner: HTMLElement[] = []; // span of each folded character
      for (const s of textSpans(page)) {
        const f = fold(s.textContent ?? '').text;
        concat += f;
        for (let k = 0; k < f.length; k++) owner.push(s);
      }
      return { concat, owner };
    });
    // A long phrase on any page first, so a shorter one that also opens an
    // earlier paragraph (an abstract echoing the intro) doesn't win.
    for (const min of [48, 20]) {
      for (const { concat, owner } of pages) {
        const at = findHead(concat, target, 0, min);
        if (at < 0) continue;
        const hit = owner[at];
        hit.scrollIntoView({ behavior: 'smooth', block: 'center' });
        hit.classList.add('sync-flash');
        setTimeout(() => hit.classList.remove('sync-flash'), 1400);
        return;
      }
    }
  }, [syncTarget]);

  // ── Project highlights onto pages ───────────────────────────────────────
  useEffect(() => {
    const container = pagesRef.current;
    if (!container) return;
    // Everything below measures client rects, which a zoom preview's stretch
    // would scale — and the boxes then go into layers that are stretched too,
    // so they came out scaled twice. Measure unstretched; put the stretch back
    // before the browser paints, so nothing visibly changes.
    const stretch = container.style.transform;
    container.style.transform = '';
    try { projectHighlights(container); } finally { container.style.transform = stretch; }
  }, [comments, renderTick, onSelectComment]);

  const projectHighlights = (container: HTMLElement) => {
    for (const layer of container.querySelectorAll('.hl-layer')) layer.innerHTML = '';

    const box = (layer: Element, c: Comment, statusCls: string, left: number, top: number, w: number, h: number) => {
      const el = document.createElement('div');
      el.className = `hl ${statusCls}`;
      el.dataset.id = c.id;
      el.title = c.text;
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      el.addEventListener('click', () => onSelectComment?.(c.id));
      layer.appendChild(el);
    };

    // Re-anchor a quote onto a page's *live* text layer, returning boxes at the
    // current glyph positions — so a highlight follows the text through
    // recompiles/reflows instead of sitting at frozen coordinates. Matching is on
    // folded letters (see ../sync): findInFolded anchors by a head and a tail
    // phrase (not the whole quote), trying progressively shorter ones so it still
    // lands when the AI rewrote words near an edge; only if even the shortest
    // head is gone do we give up (→ null) and let the caller fall back to the
    // stored rects.
    //
    // A span's `start`/`len` are in the page's folded text; `map` takes each of
    // its folded characters back to an index in the span's own raw text.
    interface Span { start: number; len: number; l: number; t: number; w: number; h: number; el: HTMLElement; map: number[] }

    // Where inside a span does folded character `k` actually fall?
    // hits() works at span granularity, but pdf.js emits spans covering many
    // words at once, so taking a span's own edge put the highlight's start up to
    // a whole span early. A Range over the text node gives the true glyph
    // position. 'left' is the left edge of character k; 'right' is the right
    // edge of character k, including any combining accent drawn over it.
    //
    // Everything here is measured in the page's VISUAL space — client rects,
    // minus the page's own origin. It used to mix spaces: offsetWidth for the
    // span boxes and a client-rect fraction reapplied to them for the edges.
    // pdf.js gives each span a `transform: scaleX(k)` so the text matches the
    // PDF's advance widths, and offsetWidth does not include that scale — so
    // every span was as wide as its layout box rather than as wide as its
    // glyphs. k is recomputed at each zoom level, which is why the highlights
    // moved when you changed zoom rather than being consistently wrong.
    const edgeInSpan = (s: Span, k: number, side: 'left' | 'right', pageLeft: number): number | null => {
      const node = s.el.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) return null;
      const raw = node.textContent ?? '';
      let rawIdx = s.map[k];
      if (rawIdx === undefined) return null;
      if (side === 'right') {
        rawIdx += (raw.codePointAt(rawIdx) ?? 0) > 0xffff ? 2 : 1;
        while (rawIdx < raw.length && /\p{M}/u.test(raw[rawIdx])) rawIdx++;
      }
      if (side === 'left' ? rawIdx >= raw.length : rawIdx <= 0) return null;
      const range = document.createRange();
      if (side === 'left') { range.setStart(node, rawIdx); range.setEnd(node, raw.length); }
      else { range.setStart(node, 0); range.setEnd(node, rawIdx); }
      const rect = range.getBoundingClientRect();
      if (!rect.width) return null;
      return (side === 'left' ? rect.left : rect.right) - pageLeft;
    };
    // A page's folded text and its spans, built once per pass: every comment
    // (and, for agent comments, every page) is matched against it.
    const pageTexts = new Map<Element, { concat: string; all: Span[]; pageBox: DOMRect }>();
    const pageText = (page: Element) => {
      const cached = pageTexts.get(page);
      if (cached) return cached;
      let concat = '';
      const all: Span[] = [];
      // Client rects, not offsets: pdf.js scales each span with a transform that
      // offsetWidth ignores, so offset geometry describes the layout box rather
      // than the glyphs. `.page` is position:relative with no border, so
      // subtracting its origin lands in exactly the coordinate space `.hl-layer`
      // (inset: 0) positions boxes in.
      const pageBox = page.getBoundingClientRect();
      // Spans are joined with nothing between them: folded text has no spaces,
      // so a word pdf.js split over two spans reads back as one word.
      for (const el of textSpans(page)) {
        const f = fold(el.textContent ?? '');
        if (!f.text) continue;
        const r = el.getBoundingClientRect();
        all.push({
          start: concat.length, len: f.text.length,
          l: r.left - pageBox.left, t: r.top - pageBox.top, w: r.width, h: r.height,
          el, map: f.map,
        });
        concat += f.text;
      }
      const built = { concat, all, pageBox };
      pageTexts.set(page, built);
      return built;
    };
    // groupLines lives in ../lines: knowing each line's FULL extent (not just the
    // matched words on it) is what lets interior lines get a flush box below, and
    // that same property is what made a two-column page paint across the gutter
    // until the grouping learned about columns. Extracted so the geometry can be
    // unit-tested with synthetic coordinates.
    const liveBoxes = (page: Element, c: Comment): { l: number; t: number; w: number; h: number }[] | null => {
      const { concat, all, pageBox } = pageText(page);
      // Stored at scale 1 by the renderer; project to what is on screen now.
      const cols: number[] = (() => {
        try { return JSON.parse((page as HTMLElement).dataset.columns ?? '[]') as number[]; } catch { return []; }
      })().map((x) => x * (parseFloat(getComputedStyle(page).getPropertyValue('--scale-factor')) || 1));
      // The occurrence whose surroundings match the comment's context, so a
      // word repeated on the page ("Partagée" as frame and block title) lights
      // up where the comment was made — the one the server placed it by.
      const match = occurrenceOn(concat, c);
      if (!match) return null;
      const { start: at, end } = match;
      const hits = (line: { spans: Span[] }) => line.spans.filter((s) => s.start < end && s.start + s.len > at);

      // Shape it like a text selection: the first touched line starts at the
      // match and runs to the LINE's own right edge; the last touched line runs
      // from the line's own left edge to the match's end; any line fully between
      // them is flush, full width, top to bottom — none of that depends on any
      // single word's box, so font-metric quirks on interior words can't
      // fragment the highlight the way per-word boxes did.
      const touched = groupLines(all, cols).filter((L) => hits(L).length > 0);
      if (!touched.length) return null;
      return touched.map((L, i) => {
        let l = L.l, r = L.r;
        if (i === 0) {
          // Prefer the exact glyph position of the matched letter; fall back to
          // the span edge when the node isn't measurable.
          const host = hits(L).find((s) => s.start <= at && at < s.start + s.len);
          l = (host && edgeInSpan(host, at - host.start, 'left', pageBox.left)) ?? Math.min(...hits(L).map((s) => s.l));
        }
        if (i === touched.length - 1) {
          const host = hits(L).find((s) => s.start < end && end <= s.start + s.len);
          r = (host && edgeInSpan(host, end - 1 - host.start, 'right', pageBox.left)) ?? Math.max(...hits(L).map((s) => s.l + s.w));
        }
        return { l, t: L.t, w: r - l, h: L.b - L.t };
      });
    };

    for (const c of comments) {
      // accepted → yellow, suggested → purple dashed, resolved → GREEN (the AI
      // did it, awaiting your review). Closing a resolved comment removes it and
      // its highlight — that's the "human-confirmed" step, so colors don't pile up.
      const statusCls = c.status === 'resolved' ? 'hl-resolved' : c.status === 'suggested' ? 'hl-suggested' : '';
      // `?.` is deliberate: the store normalizes this, but the PDF pane must not
      // be the thing that dies if a comment ever reaches it without coords.
      if (c.rects?.length) {
        // Prefer re-anchoring onto the live text so the box tracks reflow; only
        // fall back to the frozen rects (projected by scale) if the text is gone.
        const pageEl = container.querySelector(`.page[data-page="${c.page}"]`);
        const layer = pageEl?.querySelector('.hl-layer');
        if (!layer) continue;
        const boxes = liveBoxes(pageEl!, c);
        // The page's own scale, not the zoom state: during a redraw the pages
        // on screen are still the ones drawn at the previous zoom.
        const ps = pageScale(pageEl as HTMLElement);
        if (boxes) for (const b of boxes) box(layer, c, statusCls, b.l, b.t, b.w, b.h);
        else for (const r of c.rects) box(layer, c, statusCls, r.x * ps, r.y * ps, r.w * ps, r.h * ps);
        continue;
      }
      // Reviewer/agent comment posted without PDF coords, or one the server just
      // moved to another page → find the quote, starting at the page the server
      // placed it on and working outwards.
      const order = Array.from(container.querySelectorAll<HTMLElement>('.page'))
        .sort((a, b) => Math.abs(Number(a.dataset.page) - c.page) - Math.abs(Number(b.dataset.page) - c.page));
      for (const page of order) {
        const boxes = liveBoxes(page, c);
        if (!boxes) continue;
        const layer = page.querySelector('.hl-layer')!;
        for (const b of boxes) box(layer, c, statusCls, b.l, b.t, b.w, b.h);
        break;
      }
    }
  };

  // ── Selection → comment composer ────────────────────────────────────────
  const onMouseUp = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const quote = sel.toString().trim();
    if (!quote) return;
    const range = sel.getRangeAt(0);
    const pageEl = (range.startContainer.parentElement as HTMLElement | null)?.closest('.page') as HTMLElement | null;
    if (!pageEl || !scrollRef.current) return;
    const pageRect = pageEl.getBoundingClientRect();
    // Stored at scale 1, so divide by the scale the page is SHOWN at: the one it
    // was drawn at (a redraw at a new zoom may still be running) times any
    // zoom-preview stretch. Dividing by the zoom state was wrong in both cases.
    const shown = pageScale(pageEl) * (pageRect.width / (parseFloat(pageEl.style.width) || pageRect.width));
    const rects = Array.from(range.getClientRects())
      .filter((r) => r.width > 1 && r.height > 1)
      .filter((r) => r.left >= pageRect.left - 2 && r.right <= pageRect.right + 2 && r.top >= pageRect.top - 2 && r.bottom <= pageRect.bottom + 2)
      .slice(0, 40)
      .map((r) => ({ x: (r.left - pageRect.left) / shown, y: (r.top - pageRect.top) / shown, w: r.width / shown, h: r.height / shown }));
    if (!rects.length) return;
    const scroller = scrollRef.current;
    const scRect = scroller.getBoundingClientRect();
    const last = range.getClientRects()[range.getClientRects().length - 1];
    const rawX = last.right - scRect.left + scroller.scrollLeft;
    const rawY = last.bottom - scRect.top + scroller.scrollTop + 6;
    const x = Math.max(scroller.scrollLeft + 8, Math.min(rawX, scroller.scrollLeft + scroller.clientWidth - 316));
    const y = Math.min(rawY, scroller.scrollTop + scroller.clientHeight - 40);
    // The page text either side of the selection: what tells this passage apart
    // from the same words elsewhere once pages move (see src/preview/reanchor.ts).
    let prefix = '', suffix = '';
    const layer = pageEl.querySelector('.textLayer');
    if (layer?.contains(range.startContainer) && layer.contains(range.endContainer)) {
      const before = document.createRange();
      before.setStart(layer, 0);
      before.setEnd(range.startContainer, range.startOffset);
      const after = document.createRange();
      after.setStart(range.endContainer, range.endOffset);
      after.setEnd(layer, layer.childNodes.length);
      prefix = before.toString().slice(-CONTEXT_CHARS);
      suffix = after.toString().slice(0, CONTEXT_CHARS);
    }
    setDraft({ page: Number(pageEl.dataset.page), quote: quote.slice(0, 600), rects, x, y, prefix, suffix });
    setDraftText('');
  };

  const submitDraft = async () => {
    if (!draft || !draftText.trim()) return;
    await createComment({
      page: draft.page, quote: draft.quote, rects: draft.rects, text: draftText.trim(), prefix: draft.prefix, suffix: draft.suffix,
    });
    setDraft(null);
    window.getSelection()?.removeAllRanges();
  };

  const pct = Math.round((preview ?? scale) * 100);

  return (
    <div className="pdf-wrap">
      <div className="pdf-toolbar">
        <div className="pager">
          <button className="ghost" onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1} title="Previous page">▲</button>
          <input
            className="page-input"
            value={currentPage}
            onChange={(e) => { const n = Number(e.target.value.replace(/\D/g, '')); if (n) setCurrentPage(n); }}
            onKeyDown={(e) => { if (e.key === 'Enter') goToPage(currentPage); }}
            onBlur={() => goToPage(currentPage)}
          />
          <span className="of">/ {numPages || '—'}</span>
          <button className="ghost" onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= numPages} title="Next page">▼</button>
        </div>
        <span className="spacer" />
        <div className="zoom">
          <button className="ghost" onClick={() => zoomBy(1 / 1.1)} disabled={scale <= MIN_SCALE} title="Zoom out">−</button>
          <button className="zoom-val" onClick={fitWidth} title="Fit to width">{pct}%</button>
          <button className="ghost" onClick={() => zoomBy(1.1)} disabled={scale >= MAX_SCALE} title="Zoom in">+</button>
        </div>
      </div>
      <div className="pdf-scroll" ref={scrollRef} onMouseUp={onMouseUp} onClick={onClick}>
        {note && <div className={noteIsReport ? 'pdf-note pdf-note-report' : 'pdf-note'}>{note}</div>}
        <div className="pdf-pages" ref={pagesRef} />
        {draft && (
          <div className="composer" style={{ left: draft.x, top: draft.y }} onMouseUp={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
            <div className="composer-quote">“{draft.quote.slice(0, 120)}{draft.quote.length > 120 ? '…' : ''}”</div>
            <textarea
              autoFocus
              placeholder="Comment for Claude… (e.g. tighten this paragraph)"
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submitDraft(); if (e.key === 'Escape') setDraft(null); }}
            />
            <div className="composer-actions">
              <button className="ghost" onClick={() => setDraft(null)}>Cancel</button>
              <button className="on" disabled={!draftText.trim()} onClick={() => void submitDraft()}>💬 Add comment</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
