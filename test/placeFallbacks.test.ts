import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeFallbacks } from '../src/engine/fallbackStyles.js';

// busytex runs TeX from the main file's directory with no TEXINPUTS: a .sty
// anywhere else is invisible to it, ours or the project's.

const fb = (path: string) => ({ path, content: '% fallback', encoding: 'utf8' as const });
const src = (path: string) => ({ path, content: '', encoding: 'utf8' as const });

test('fallbacks go next to a main file in a subdirectory', () => {
  const out = placeFallbacks([fb('multirow.sty')], [src('lectures/week6/main.tex')], 'lectures/week6/main.tex');
  assert.deepEqual(out.map((f) => f.path), ['lectures/week6/multirow.sty']);
});

test('and stay at the root for a main file there', () => {
  const out = placeFallbacks([fb('multirow.sty')], [src('main.tex')], 'main.tex');
  assert.deepEqual(out.map((f) => f.path), ['multirow.sty']);
});

test('a project copy beside the main file wins over ours', () => {
  const out = placeFallbacks([fb('multirow.sty')], [src('lectures/week6/multirow.sty')], 'lectures/week6/main.tex');
  assert.deepEqual(out, []);
});

test('a project copy the bundled TeX cannot see does not suppress ours', () => {
  const files = [src('multirow.sty'), src('styles/multirow.sty'), src('lectures/week6/main.tex')];
  const out = placeFallbacks([fb('multirow.sty')], files, 'lectures/week6/main.tex');
  assert.deepEqual(out.map((f) => f.path), ['lectures/week6/multirow.sty']);
});
