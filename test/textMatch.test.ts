import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, findInFolded, foldSource, locateAcross, locateInSource, stripLatex } from '../src/preview/textMatch.js';

// Where a folded quote lands, as the raw substring it covers.
const rawMatch = (raw: string, quote: string) => {
  const f = fold(raw);
  const m = findInFolded(f.text, fold(quote).text);
  if (!m) return null;
  return raw.slice(f.map[m.start], f.map[m.end - 1] + 1);
};

test('fold: accents fold away, in either Unicode form', () => {
  const nfc = 'été à Paris'.normalize('NFC');
  const nfd = 'été à Paris'.normalize('NFD');
  assert.notEqual(nfc, nfd);
  assert.equal(fold(nfc).text, 'eteaparis');
  assert.equal(fold(nfd).text, 'eteaparis');
  assert.equal(fold('Français, œuvre, straße').text, 'francaisoeuvrestrasse');
});

test('fold: spacing accent glyphs (non-T1 fonts) are dropped, not word breaks', () => {
  assert.equal(fold('caf´e').text, 'cafe');
  assert.equal(fold('cafe´').text, 'cafe');
  assert.equal(fold('ˆetre').text, 'etre');
  assert.equal(fold('na¨ıve').text, 'naive');
});

test('fold: map points each folded char at its raw character', () => {
  const raw = 'un été';
  const f = fold(raw);
  assert.equal(f.text, 'unete');
  assert.deepEqual(f.map, [0, 1, 3, 4, 5]);
  // NFD: the base letter maps to itself; its combining accent is dropped.
  const d = fold('e\u0301t');
  assert.equal(d.text, 'et');
  assert.deepEqual(d.map, [0, 2]);
  // A ligature expands to two letters, both at the ligature's index.
  const lig = fold('ﬁn');
  assert.equal(lig.text, 'fin');
  assert.deepEqual(lig.map, [0, 0, 1]);
});

test('findInFolded: a quote starting and ending on an accent is not clipped', () => {
  assert.equal(rawMatch('Nous avons un été très chaud cette année.', 'été très chaud cette année'), 'été très chaud cette année');
  assert.equal(rawMatch('Il est allé à la plage.', 'à la plage'), 'à la plage');
});

test('findInFolded: a selection across a hyphenated line break matches', () => {
  // pdf.js text layer: "high-" then a line break, then "lighting".
  assert.equal(rawMatch('we use high-\nlighting in the PDF', 'use highlighting in the'), 'use high-\nlighting in the');
  // The user's own selection carries the hyphen and the newline too.
  assert.equal(rawMatch('we use high-\nlighting in the PDF', 'use high-\nlighting in'), 'use high-\nlighting in');
});

test('findInFolded: a word pdf.js split over two spans still matches', () => {
  // Spans are concatenated with no separator; "résu" + "mé" is one word.
  const page = fold('Le résu').text + fold('mé du papier').text;
  assert.ok(findInFolded(page, fold('résumé du papier').text));
});

test('findInFolded: head/tail anchoring survives an edit in the middle', () => {
  const page = fold('The quick brown fox jumps over the lazy dog and then runs far away into the forest.').text;
  const quote = fold('The quick brown fox leaps over the lazy dog and then runs far away into the forest.').text;
  const m = findInFolded(page, quote);
  assert.ok(m);
  assert.equal(m!.start, 0);
  assert.equal(m!.end, page.length);
});

test('stripLatex: accent macros and letter macros keep their letters', () => {
  assert.equal(fold(stripLatex("caf\\'e")).text, 'cafe');
  assert.equal(fold(stripLatex("caf\\'{e}")).text, 'cafe');
  assert.equal(fold(stripLatex('fran\\c{c}ais')).text, 'francais');
  assert.equal(fold(stripLatex('\\oe uvre, Stra\\ss e, na\\"\\i ve')).text, 'oeuvrestrassenaive');
  // ...but \item and \label aren't mistaken for \i and \l.
  assert.equal(fold(stripLatex('\\item Bonjour \\label{sec:x}')).text, 'bonjour');
});

test('stripLatex: citation keys and \\% are handled', () => {
  assert.equal(fold(stripLatex('as shown~\\cite[p.~3]{smith2020} before')).text, 'asshownbefore');
  assert.equal(fold(stripLatex('50\\% of runs % a comment')).text, '50ofruns');
});

test('locateInSource: French quote, UTF-8 or macro-accented source', () => {
  const quote = 'Nous présentons une méthode générale pour le rendu';
  assert.equal(locateInSource('\\section{Intro}\nNous présentons une méthode générale pour le rendu.\n', quote), 1);
  assert.equal(locateInSource("\\section{Intro}\nNous pr\\'esentons une m\\'ethode g\\'en\\'erale pour le rendu.\n", quote), 1);
});

test('locateInSource: a phrase across a hard-wrapped source line', () => {
  const src = 'Intro.\nWe propose a new estimator that\nreduces variance without bias.\n';
  assert.equal(locateInSource(src, 'new estimator that reduces variance'), 1);
});

test('stripLatex: \\\\% is a line break then a comment', () => {
  assert.equal(fold(stripLatex('first row\\\\% TODO fix wording')).text, 'firstrow');
  assert.equal(fold(stripLatex('% whole-line comment')).text, '');
});

test('findInFolded: a short tail that also occurs inside the quote is taken at the end', () => {
  const page = fold('We train on images of the dataset; after that we measure how robust the outputs of the dataset are.').text;
  // The end of the quote was rewritten, so only the 12-char tail "ofthedataset"
  // still matches — and it occurs twice, the first time inside the quote.
  const quote = fold('We train on images of the dataset; after that we evaluate the robustness of the dataset').text;
  const m = findInFolded(page, quote);
  assert.ok(m);
  assert.equal(m!.start, 0);
  assert.equal(m!.end, page.lastIndexOf('ofthedataset') + 'ofthedataset'.length);
});

test('locateAcross: a long phrase in a later file beats a short one in an earlier file', () => {
  const abstract = foldSource('In this paper we propose a method.\n');
  const intro = foldSource('Intro.\nIn this paper we propose a new estimator that reduces variance.\n');
  const hit = locateAcross([['abstract.tex', abstract], ['intro.tex', intro]], 'In this paper we propose a new estimator that reduces variance');
  assert.deepEqual(hit, { key: 'intro.tex', line: 1 });
});

test('locateInSource: text LaTeX generated before the prose (numbers, captions) still lands', () => {
  // Clicking "1 Introduction" in the PDF sends "1 Introduction Graphics…".
  const src = '\\section{Introduction}\nGraphics rendering is a classic problem.\n';
  assert.equal(locateInSource(src, '1 Introduction Graphics rendering is a classic'), 0);
  const fig = 'x\n\\caption{Overview of our rendering method}\n';
  assert.equal(locateInSource(fig, 'Figure 2: Overview of our rendering method'), 1);
});

test('locateInSource: lines that fold to nothing do not shift the reported line', () => {
  const src = 'Intro.\n\n\\label{x}\n%c\nWe propose a new estimator that reduces variance.\n';
  assert.equal(locateInSource(src, 'We propose a new estimator that reduces variance'), 4);
});
