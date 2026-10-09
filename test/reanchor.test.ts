import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextAt, foldPages, placeQuote } from '../src/preview/reanchor.js';
import { addComment, listComments, reanchorComments } from '../src/preview/commentsStore.js';

// A small deck: each string is one page's text, as pdf.js extracts it.
const title = 'Cours 06 : OpenMP';
const slide = (head: string, body: string) => `${title}${head}${body}`;
const scope = slide('Portée des variables', 'Privée Une copie par thread Partagée Une seule variable, vue de tous');
const question = slide('Question : qu’affiche ce programme ?', '#pragma omp parallel private( i )');
const loops = slide('Boucles', 'Réécrite, puis partagée : un indice entier');

test('a comment follows its slide when pages are inserted before it', () => {
  const before = [slide('Titre', ''), scope, question, loops];
  const after = [slide('Titre', ''), slide('Nouveau', 'une diapo de plus'), slide('Encore', 'et une autre'), scope, question, loops];
  const anchor = { page: 3, quote: 'omp parallel private( i )' };
  assert.equal(placeQuote(foldPages(before), anchor)?.page, 3);
  assert.equal(placeQuote(foldPages(after), anchor)?.page, 5);
});

test('beamer overlays: the comment goes to the first overlay showing the passage', () => {
  // The scope slide becomes three overlays; "Partagée" appears from the second.
  const step1 = slide('Portée des variables', 'Privée Une copie par thread');
  const step3 = scope + ' Conseil : default( none )';
  const after = [slide('Titre', ''), step1, scope, step3, question, loops];
  assert.equal(placeQuote(foldPages(after), { page: 3, quote: 'omp parallel private( i )' })?.page, 5);
  // Old page 2 is now overlay 1, which doesn't show the passage yet.
  assert.equal(placeQuote(foldPages(after), { page: 2, quote: 'Une seule variable, vue de tous' })?.page, 3);
});

test('a comment that did not move stays put, even on a repeated passage', () => {
  const pages = foldPages([scope, scope, scope]);
  assert.equal(placeQuote(pages, { page: 2, quote: 'Une seule variable' })?.page, 2);
});

test('the surrounding text tells repeated words apart', () => {
  const pages = [scope, question, loops];
  const p = placeQuote(foldPages(pages), { page: 3, quote: 'Partagée' })!;
  // No context: the old page still holds the word, so it stays.
  assert.equal(p.page, 3);
  // With the context of the scope slide, it goes there, even from page 3.
  const ctx = contextAt(scope, placeQuote(foldPages([scope]), { page: 1, quote: 'Partagée' })!);
  assert.match(ctx.prefix, /copie par thread $/);
  assert.match(ctx.suffix, /^ Une seule variable/);
  assert.equal(placeQuote(foldPages(pages), { page: 3, quote: 'Partagée', ...ctx })?.page, 1);
});

test('a passage that is gone, or too short to place, has no page', () => {
  assert.equal(placeQuote(foldPages([scope, question]), { page: 1, quote: 'nowhere in this deck' }), null);
  assert.equal(placeQuote(foldPages([scope]), { page: 1, quote: 'Pr' }), null);
});

test('reanchorComments writes only what changed, and clears stale', async () => {
  const d = mkdtempSync(join(tmpdir(), 'ra-'));
  try {
    const c = await addComment(d, { page: 2, quote: 'q', rects: [{ x: 1, y: 1, w: 1, h: 1 }], text: 'fix' });
    assert.equal(await reanchorComments(d, () => ({ page: 2 })), false);
    assert.equal(await reanchorComments(d, () => ({ page: 4, rects: [], stale: true })), true);
    let [after] = await listComments(d);
    assert.deepEqual([after.id, after.page, after.rects, after.stale], [c.id, 4, [], true]);
    assert.equal(await reanchorComments(d, () => ({ stale: false, prefix: 'a', suffix: 'b' })), true);
    [after] = await listComments(d);
    assert.equal(after.stale, undefined);
    assert.deepEqual([after.prefix, after.suffix], ['a', 'b']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
