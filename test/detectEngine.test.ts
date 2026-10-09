import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectEngine } from '../src/project/detectEngine.js';

// A document written for pdflatex (`\pdfcompresslevel`, inputenc + T1) dies
// under the xelatex default, and the only fix used to be passing `engine` by
// hand on every session. The magic comment lets the document say so itself.

test('the magic comment names the engine', () => {
  assert.equal(detectEngine('% !TEX program = pdflatex\n\\documentclass{beamer}\n'), 'pdflatex');
  assert.equal(detectEngine('% !TEX program = lualatex\n\\documentclass{article}\n'), 'lualatex');
  assert.equal(detectEngine('% !TEX program = xelatex\n\\documentclass{article}\n'), 'xelatex');
});

test('the spellings editors write are all accepted', () => {
  assert.equal(detectEngine('% !TEX TS-program = pdflatex\n\\documentclass{article}\n'), 'pdflatex', 'TeXShop form');
  assert.equal(detectEngine('%!TEX program=pdflatex\n\\documentclass{article}\n'), 'pdflatex', 'no spaces');
  assert.equal(detectEngine('  %  ! TeX Program = PDFLaTeX\n\\documentclass{article}\n'), 'pdflatex', 'mixed case');
  assert.equal(detectEngine('% a title line\n% !TEX root = x\n% !TEX program = pdflatex\n\\documentclass{article}\n'), 'pdflatex', 'not the first line');
});

test('TeXShop\'s latexmk variants name the same engine', () => {
  assert.equal(detectEngine('% !TEX TS-program = pdflatexmk\n\\documentclass{article}\n'), 'pdflatex');
  assert.equal(detectEngine('% !TEX TS-program = xelatexmk\n\\documentclass{article}\n'), 'xelatex');
});

test('only the header counts — a magic comment after \\documentclass is ignored', () => {
  assert.equal(detectEngine('\\documentclass{article}\n% !TEX program = pdflatex\n'), 'xelatex');
});

test('without one, xelatex', () => {
  assert.equal(detectEngine('\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n'), 'xelatex');
  assert.equal(detectEngine(''), 'xelatex');
  assert.equal(detectEngine('% !TEX program = context\n\\documentclass{article}\n'), 'xelatex', 'an engine we cannot run is not honoured');
});
