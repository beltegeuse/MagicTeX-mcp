import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  anchorUpdate, contextAt, foldPages, locate, locateOn, pageSignature, type AnchoredComment, type Placement,
} from '../src/preview/reanchor.js';
import { addComment, listComments, reanchorComments } from '../src/preview/commentsStore.js';

// A small deck: each string is one page's text, as pdf.js extracts it.
const title = 'Cours 06 : OpenMP';
const slide = (head: string, body: string) => `${title}${head}${body}`;
const scope = slide('Portée des variables', 'Privée Une copie par thread Partagée Une seule variable, vue de tous');
const question = slide('Question : qu’affiche ce programme ?', '#pragma omp parallel private( i )');
const loops = slide('Boucles', 'Réécrite, puis partagée : un indice entier');
const intro = slide('Introduction', 'OpenMP parallélise une boucle sans réécrire le programme entier.');

type Tracked = AnchoredComment & { current?: string; stale?: boolean };
type A = Omit<AnchoredComment, 'rects'> & { rects?: unknown[] };
const where = (pages: string[], a: A) => locate(foldPages(pages), { rects: [], ...a });
const at = (pages: string[], a: A) => where(pages, a) as Placement;
/** A comment made by selecting `quote` on page `page` of `pages`, as the workspace makes it. */
const made = (pages: string[], page: number, quote: string): Tracked => {
  const p = at([pages[page - 1]], { page: 1, quote });
  return { page, quote, rects: [{ x: 1, y: 1, w: 1, h: 1 }], ...contextAt(pages[page - 1], p) };
};
/** Re-anchor `c` against `pages` and apply the update, as the store does. */
const step = (pages: string[], c: Tracked): Tracked => {
  const u = anchorUpdate(foldPages(pages), pages, c);
  if (!u) return c;
  const { current, stale, ...rest } = u;
  const next: Tracked = { ...c, ...rest };
  if (current === null) delete next.current; else if (current !== undefined) next.current = current;
  if (stale === false) delete next.stale; else if (stale) next.stale = true;
  return next;
};

test('a comment follows its slide when pages are inserted before it', () => {
  const before = [slide('Titre', ''), scope, question, loops];
  const after = [slide('Titre', ''), slide('Nouveau', 'une diapo de plus'), slide('Encore', 'et une autre'), scope, question, loops];
  const anchor = { page: 3, quote: 'omp parallel private( i )' };
  assert.equal(at(before, anchor).page, 3);
  assert.equal(at(after, anchor).page, 5);
});

test('beamer overlays: the comment goes to the first overlay showing the passage', () => {
  // The scope slide becomes three overlays; "Partagée" appears from the second.
  const step1 = slide('Portée des variables', 'Privée Une copie par thread');
  const step3 = scope + ' Conseil : default( none )';
  const after = [slide('Titre', ''), step1, scope, step3, question, loops];
  assert.equal(at(after, { page: 3, quote: 'omp parallel private( i )' }).page, 5);
  // Old page 2 is now overlay 1, which doesn't show the passage yet.
  assert.equal(at(after, { page: 2, quote: 'Une seule variable, vue de tous' }).page, 3);
});

test('a comment that did not move stays put, even on a repeated passage', () => {
  assert.equal(at([scope, scope, scope], { page: 2, quote: 'Une seule variable' }).page, 2);
});

test('the surrounding text tells repeated words apart', () => {
  const pages = [scope, question, loops];
  // No context: the old page still holds the word, so it stays.
  assert.equal(at(pages, { page: 3, quote: 'Partagée' }).page, 3);
  // With the context of the scope slide, it goes there, even from page 3.
  const ctx = contextAt(scope, at([scope], { page: 1, quote: 'Partagée' }));
  assert.match(ctx.prefix, /copie par thread $/);
  assert.match(ctx.suffix, /^ Une seule variable/);
  assert.equal(at(pages, { page: 3, quote: 'Partagée', ...ctx }).page, 1);
});

test('a passage with nothing left to find it by is missing; one too short to place has no answer', () => {
  assert.equal(where([scope, question], { page: 1, quote: 'nowhere in this deck' }), 'missing');
  assert.equal(where([scope], { page: 1, quote: 'Pr' }), null);
});

test('only an unambiguous placement is sure', () => {
  assert.equal(at([scope, question], { page: 1, quote: 'Une seule variable' }).sure, true);
  assert.equal(at([scope, scope], { page: 1, quote: 'Une seule variable' }).sure, false);
  const twice = slide('Privée ou partagée', 'Partagée Une seule variable');
  assert.equal(at([twice], { page: 1, quote: 'Partagée' }).sure, false);
  assert.equal(at([twice], { page: 1, quote: 'Partagée', suffix: 'Une seule' }).sure, true);
});

test('the highlighted occurrence is the one the context points at', () => {
  const page = foldPages([slide('Privée ou partagée', 'Partagée Une seule variable')])[0];
  const first = locateOn(page, { quote: 'Partagée' })!;
  const block = locateOn(page, { quote: 'Partagée', suffix: 'Une seule variable' })!;
  assert.ok(block.start > first.start);
  assert.equal(page.slice(block.end, block.end + 3), 'une');
});

// ── Addressing a comment rewrites or deletes its passage ──────────────────

test('a passage rewritten in place: found by its context, and what replaced it is known', () => {
  const before = [intro, scope, question];
  let c = step(before, made(before, 1, 'sans réécrire le programme entier'));
  const after = [slide('Introduction', 'OpenMP parallélise une boucle en ajoutant une seule directive.'), scope, question];
  c = step(after, c);
  assert.equal(c.page, 1);
  assert.equal(c.current, 'en ajoutant une seule directive');
  assert.equal(c.stale, undefined);
  // The workspace highlights the new words.
  const span = locateOn(foldPages(after)[0], c)!;
  assert.equal(foldPages(after)[0].slice(span.start, span.end), 'enajoutantuneseuledirective');
});

test('a passage rewritten while pages were added before it still follows its slide', () => {
  const before = [intro, scope, question];
  let c = step(before, made(before, 2, 'Une seule variable, vue de tous'));
  const newScope = slide('Portée des variables', 'Privée Une copie par thread Partagée Visible par tous les threads');
  const after = [intro, slide('Rappel', 'Les threads'), slide('Plan', 'Trois parties'), newScope, question];
  c = step(after, c);
  assert.equal(c.page, 4);
  assert.equal(c.current, 'Visible par tous les threads');
  assert.deepEqual(c.rects, []); // the old boxes belonged to page 2
});

test('a deleted passage: an empty span at the spot where it was', () => {
  const before = [intro, scope, question];
  let c = step(before, made(before, 2, 'Une copie par thread'));
  const after = [intro, slide('Portée des variables', 'Privée Partagée Une seule variable, vue de tous'), question];
  c = step(after, c);
  assert.equal(c.page, 2);
  assert.equal(c.current, '');
  const spot = locateOn(foldPages(after)[1], c)!;
  assert.equal(spot.start, spot.end);
  assert.equal(foldPages(after)[1].slice(spot.start, spot.start + 8), 'partagee');
});

test('an edit that also touched the edges of the context still lands', () => {
  const before = [intro, scope, question];
  let c = step(before, made(before, 2, 'Une copie par thread'));
  // "Privée" became "Variable privée", and the quote was rewritten.
  const after = [intro, slide('Portée des variables', 'Variable privée Chaque thread a la sienne Partagée Une seule variable, vue de tous'), question];
  c = step(after, c);
  assert.equal(c.page, 2);
  assert.equal(c.stale, undefined);
  // The span takes in the edited words next to the quote, whole.
  assert.match(c.current!, /^\S*\s?Variable privée Chaque thread a la sienne$/);
});

test('the whole sentence around the quote rewritten, lines glued as pdf.js joins them', () => {
  // pdf.js puts nothing between lines: "égaux.Cette".
  const body = (s: string) => slide('Méthode', `Nous découpons le tableau en blocs égaux.${s}Les blocs sont ensuite combinés.`);
  const before = [intro, body('Cette phrase explique la méthode de façon confuse.')];
  let c = step(before, made(before, 2, 'la méthode de façon confuse'));
  c = step([intro, body('Chaque thread calcule une somme partielle, puis on les additionne.')], c);
  // Exactly the new words: not "égaux." before them, not "Les" after.
  assert.equal(c.current, 'Chaque thread calcule une somme partielle, puis on les additionne');
  // And the workspace highlights those words, from the C of "Chaque" — which
  // the old "Cette" also started with.
  const page = foldPages([body('Chaque thread calcule une somme partielle, puis on les additionne.')])[0];
  const span = locateOn(page, c)!;
  assert.equal(page.slice(span.start, span.end), 'chaquethreadcalculeunesommepartiellepuisonlesadditionne');
});

test('the passage and its surroundings rewritten, pages added: the page is estimated', () => {
  const rest = ' Le compteur partagé est protégé par une section critique nommée.';
  const extra = slide('Exemple', 'Somme des éléments d’un tableau, chaque thread garde une somme partielle locale puis les combine.' + rest);
  const before = [intro, scope, extra, question];
  let c = step(before, made(before, 3, 'Somme des éléments'));
  assert.ok(c.pageSig?.length, 'a found comment remembers its page');
  // The whole sentence is rewritten (context included); the rest of the slide stays.
  const rewritten = slide('Exemple', 'Additionner : on réduit en local, puis on fusionne les résultats.' + rest);
  const after = [intro, slide('A', 'a a a a'), slide('B', 'b b b b'), scope, rewritten, question];
  c = step(after, c);
  assert.equal(c.page, 5);
  assert.equal(c.stale, true);
  assert.deepEqual(c.rects, []);
});

test('the same edit without pages added: found by what is left of its context', () => {
  const extra = slide('Exemple', 'Somme des éléments d’un tableau avec une réduction et un compteur partagé');
  const before = [intro, scope, extra, question];
  let c = step(before, made(before, 3, 'Somme des éléments'));
  const after = [intro, scope, slide('Exemple', 'Additionner un tableau : avec une réduction et un compteur partagé'), question];
  c = step(after, c);
  assert.equal(c.page, 3);
  assert.equal(c.stale, undefined);
  assert.match(c.current!, /Additionner/);
});

test('nothing at all left: the old behaviour, page and boxes kept', () => {
  const before = [intro, scope, question];
  const c0 = step(before, made(before, 2, 'Une copie par thread'));
  const c = step([slide('Autre', 'rien à voir'), slide('Encore', 'toujours rien')], c0);
  assert.equal(c.page, 2);
  assert.deepEqual(c.rects, c0.rects);
  assert.equal(c.stale, true);
});

test('the quote coming back clears what replaced it', () => {
  const before = [intro, scope, question];
  let c = step(before, made(before, 2, 'Une copie par thread'));
  c = step([intro, slide('Portée des variables', 'Privée Partagée Une seule variable, vue de tous'), question], c);
  assert.equal(c.current, '');
  c = step(before, c);
  assert.equal(c.current, undefined);
});

test('pageSignature skips the header every page shares', () => {
  const raw = [intro, scope, question, loops];
  const pages = foldPages(raw);
  const p = at(raw, { page: 2, quote: 'Une seule variable' });
  const sig = pageSignature(pages, 2, p.start, p.end);
  assert.ok(sig.length > 0);
  for (const ph of sig) assert.ok(!pages.every((t) => t.includes(ph)), `${ph} is on every page`);
});

test('anchorUpdate: an agent quote that never matched the PDF is left alone', () => {
  const pages = [scope, question];
  assert.equal(anchorUpdate(foldPages(pages), pages, { page: 1, quote: 'texte réécrit depuis', rects: [] }), null);
});

test('anchorUpdate: context is written down only for a sure placement', () => {
  const pages = [scope, scope, question];
  const folded = foldPages(pages);
  const guess = anchorUpdate(folded, pages, { page: 1, quote: 'Une seule variable', rects: [] })!;
  assert.equal(guess.prefix, undefined);
  const sure = anchorUpdate(folded, pages, { page: 1, quote: 'omp parallel private( i )', rects: [] })!;
  assert.equal(sure.page, 3);
  assert.match(sure.prefix!, /programme \?#pragma $/);
});

test('reanchorComments writes only what changed, and clears stale and current', async () => {
  const d = mkdtempSync(join(tmpdir(), 'ra-'));
  try {
    const c = await addComment(d, { page: 2, quote: 'q', rects: [{ x: 1, y: 1, w: 1, h: 1 }], text: 'fix' });
    assert.equal(await reanchorComments(d, () => ({ page: 2 })), false);
    assert.equal(await reanchorComments(d, () => ({ page: 4, rects: [], stale: true, current: '' })), true);
    let [after] = await listComments(d);
    assert.deepEqual([after.id, after.page, after.rects, after.stale, after.current], [c.id, 4, [], true, '']);
    assert.equal(await reanchorComments(d, () => ({ stale: false, current: null, prefix: 'a', suffix: 'b', pageSig: ['x'] })), true);
    [after] = await listComments(d);
    assert.equal(after.stale, undefined);
    assert.equal(after.current, undefined);
    assert.deepEqual([after.prefix, after.suffix, after.pageSig], ['a', 'b', ['x']]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
