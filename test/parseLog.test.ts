import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTexLog, summarizeErrors } from '../src/project/parseLog.js';

// TeX runs from the main file's directory, so a document at
// lectures/week6/main.tex reports `./style.tex:58`. The reader (and Claude)
// need the path from the project root to open the right file.

const LOG = [
  './style.tex:58: Undefined control sequence.',
  'l.58 \\pdfcompresslevel',
  '',
  'chapters/intro.tex:3: LaTeX Error: File `x.sty\' not found.',
].join('\n');

test('error paths are rebased onto the main file\'s directory', () => {
  const errs = parseTexLog(LOG, 'lectures/week6');
  assert.equal(errs[0].file, 'lectures/week6/style.tex');
  assert.equal(errs[0].line, 58);
  assert.equal(errs[1].file, 'lectures/week6/chapters/intro.tex', 'a path without ./ is relative too');
});

test('a main file at the root leaves paths alone', () => {
  assert.equal(parseTexLog(LOG)[0].file, 'style.tex');
  assert.equal(parseTexLog(LOG, '.')[0].file, 'style.tex');
});

test('paths that climb out of the main directory are normalised', () => {
  const errs = parseTexLog('../shared/macros.tex:7: Undefined control sequence.', 'lectures/week6');
  assert.equal(errs[0].file, 'lectures/shared/macros.tex');
});

test('absolute paths are kept as TeX printed them', () => {
  const errs = parseTexLog('/usr/share/texmf/tex/latex/foo.sty:12: Oops.', 'lectures/week6');
  assert.equal(errs[0].file, '/usr/share/texmf/tex/latex/foo.sty');
});

test('the summary shows the rebased path', () => {
  assert.match(summarizeErrors(LOG, 'lectures/week6'), /\[lectures\/week6\/style\.tex:58\]/);
});
