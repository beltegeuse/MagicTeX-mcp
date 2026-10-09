import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileWithSystemTex, hasSystemTex } from '../src/engine/systemTex.js';

// A main file in a subdirectory that inputs a file next to itself — the shape
// of a course repo with one folder per lecture. latexmk used to run from the
// project root, where `\input{style}` finds nothing.

function project(t: { after: (fn: () => void) => void }, main: string): string {
  const root = mkdtempSync(join(tmpdir(), 'magictex-subdir-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'lectures', 'week6'), { recursive: true });
  mkdirSync(join(root, 'lectures', 'common'), { recursive: true });
  writeFileSync(join(root, 'lectures', 'week6', 'style.tex'), '\\newcommand{\\hello}{Hello}\n');
  writeFileSync(join(root, 'lectures', 'common', 'macros.tex'), '\\newcommand{\\world}{world}\n');
  writeFileSync(join(root, 'lectures', 'week6', 'main.tex'), main);
  return root;
}

test('the local TeX resolves \\input relative to the main file', async (t) => {
  if (!(await hasSystemTex())) { t.skip('no local TeX'); return; }
  const root = project(t, '\\documentclass{article}\n\\input{style}\n\\begin{document}\n\\hello\n\\end{document}\n');
  const out = await compileWithSystemTex(root, 'lectures/week6/main.tex', 'pdflatex');
  assert.equal(out.success, true, out.error ?? out.log?.slice(-800));
  assert.ok(out.pdfLen > 0);
});

test('paths from the project root still resolve, as they did before', async (t) => {
  if (!(await hasSystemTex())) { t.skip('no local TeX'); return; }
  const root = project(t, '\\documentclass{article}\n\\input{lectures/common/macros}\n\\begin{document}\n\\world\n\\end{document}\n');
  const out = await compileWithSystemTex(root, 'lectures/week6/main.tex', 'pdflatex');
  assert.equal(out.success, true, out.error ?? out.log?.slice(-800));
});

test('an absolute main file names its own directory', async (t) => {
  if (!(await hasSystemTex())) { t.skip('no local TeX'); return; }
  const root = project(t, '\\documentclass{article}\n\\input{style}\n\\begin{document}\n\\hello\n\\end{document}\n');
  // join(root, dirname(abs)) was a directory that does not exist — spawn
  // failed with ENOENT, which reads as "latexmk is not installed".
  const out = await compileWithSystemTex(root, join(root, 'lectures', 'week6', 'main.tex'), 'pdflatex');
  assert.equal(out.success, true, out.error ?? out.log?.slice(-800));
});
