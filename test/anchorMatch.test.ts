import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAnchor } from '../src/preview/anchorMatch.js';

const project = (main: string) => {
  const d = mkdtempSync(join(tmpdir(), 'am-'));
  writeFileSync(join(d, 'main.tex'), main);
  return d;
};

test('locates a prose quote at the right file:line', async () => {
  const d = project('\\documentclass{article}\n\\begin{document}\nThe quick brown fox jumps over the lazy dog here.\n\\end{document}\n');
  try {
    const a = await findAnchor(d, 'quick brown fox jumps over the lazy dog');
    assert.ok(a, 'expected a match');
    assert.equal(a!.file, 'main.tex');
    assert.equal(a!.line, 3);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('matches through LaTeX markup (ignores commands)', async () => {
  const d = project('\\documentclass{article}\n\\begin{document}\nWe find a \\textbf{large speedup} on the benchmark today.\n\\end{document}\n');
  try {
    const a = await findAnchor(d, 'large speedup on the benchmark');
    assert.ok(a);
    assert.equal(a!.line, 3);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('returns null for a quote that is not there', async () => {
  const d = project('\\documentclass{article}\n\\begin{document}\nHello world.\n\\end{document}\n');
  try {
    assert.equal(await findAnchor(d, 'nonexistent passage zzz qqq wibble'), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('locates a French quote whatever the accent spelling in the source', async () => {
  const d = project("\\documentclass{article}\n\\begin{document}\nNous pr\\'esentons une m\\'ethode g\\'en\\'erale.\n\\end{document}\n");
  try {
    const a = await findAnchor(d, 'présentons une méthode générale');
    assert.ok(a);
    assert.equal(a!.line, 3);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('locates a quote that crosses a hard-wrapped line or a hyphenated word', async () => {
  const d = project('\\documentclass{article}\n\\begin{document}\nWe propose a new estimator that\nreduces variance with no highlighting bias.\n\\end{document}\n');
  try {
    const a = await findAnchor(d, 'new estimator that reduces variance');
    assert.ok(a);
    assert.equal(a!.line, 3);
    const b = await findAnchor(d, 'variance with no high-\nlighting bias');
    assert.ok(b);
    assert.equal(b!.line, 4);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a short quote found in several files is told apart by its page', async () => {
  const d = mkdtempSync(join(tmpdir(), 'am-'));
  try {
    writeFileSync(join(d, 'main.tex'), '\\documentclass{beamer}\n\\begin{document}\n\\input{boucles}\n\\input{portee}\n\\end{document}\n');
    writeFileSync(join(d, 'boucles.tex'), '\\begin{frame}{Boucles}\n\\myemph{Réécrite, puis partagée}\nUn indice entier.\n\\end{frame}\n');
    writeFileSync(join(d, 'portee.tex'), [
      '\\begin{frame}{Portée des variables : privée ou partagée}',
      '\\begin{block}{Privée}',
      '\\item Une \\myemph{copie par thread}',
      '\\end{block}',
      '\\begin{block}{Partagée}',
      '\\item Une seule variable, vue de \\myemph{tous}',
      '\\end{block}',
      '\\end{frame}',
    ].join('\n'));
    // Without context: whichever file comes first.
    assert.equal((await findAnchor(d, 'Partagée'))!.file, 'boucles.tex');
    // With the page it is on: the scope slide.
    const pageText = 'Portée des variables : privée ou partagéePrivéeUne copie par threadPartagéeUne seule variable, vue de tous';
    const onPage = await findAnchor(d, 'Partagée', { pageText });
    assert.equal(onPage!.file, 'portee.tex');
    // And the prefix/suffix pick the block title, not the frame title.
    const exact = await findAnchor(d, 'Partagée', { pageText, prefix: 'Une copie par thread', suffix: 'Une seule variable' });
    assert.deepEqual([exact!.file, exact!.line], ['portee.tex', 5]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
