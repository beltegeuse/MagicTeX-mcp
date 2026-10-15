import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeWatchError } from '../src/watch/fileWatcher.js';

// Started from the root of a large repository, the watcher ran out of file
// handles and its unhandled 'error' event killed the server: Claude Code only
// saw "Connection closed". The message must now say what ran out, where, and
// what to do about it.

const errno = (code: string, message: string) => Object.assign(new Error(message), { code });

test('running out of handles names the root and says where to start Claude Code', () => {
  for (const code of ['EMFILE', 'ENFILE', 'ENOSPC']) {
    const msg = describeWatchError(errno(code, `${code}: too many, watch`), '/repo');
    assert.match(msg, /\/repo/);
    assert.match(msg, new RegExp(code));
    assert.match(msg, /Start Claude Code from the folder that holds the LaTeX sources/);
  }
});

test('any other error keeps its code and message', () => {
  const msg = describeWatchError(errno('EACCES', 'permission denied'), '/repo');
  assert.equal(msg, 'watching /repo failed (EACCES: permission denied).');
  assert.equal(describeWatchError('boom', '/repo'), 'watching /repo failed (boom).');
});
