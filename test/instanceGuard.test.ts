import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { fromOtherInstance, INSTANCE_HEADER, STALE_HEADER } from '../src/preview/instanceGuard.js';
import { startPreviewServer } from '../src/preview/previewServer.js';
import { getProjectRoot, setProjectRoot } from '../src/session.js';

// With a pinned MAGICTEX_PORT, a tab whose server crashed reconnects to whatever
// server next takes that port — possibly another project's — and its autosave
// would write its buffer into that project. A write must name the server it
// was loaded from, and a server must refuse one that names another.

const req = (method: string, sent?: string) =>
  ({ method, headers: sent === undefined ? {} : { [INSTANCE_HEADER]: sent } }) as unknown as IncomingMessage;

test('a write naming another server is refused', () => {
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(fromOtherInstance(req(m, 'old'), 'new'), true, m);
});

test('a write naming this server, or none, goes through', () => {
  assert.equal(fromOtherInstance(req('PUT', 'same'), 'same'), false);
  // The legacy viewer, and a tab that has not heard the id yet, send nothing.
  assert.equal(fromOtherInstance(req('PUT'), 'same'), false);
  assert.equal(fromOtherInstance(req('PUT', ''), 'same'), false);
});

test('reads are never refused on this ground', () => {
  for (const m of ['GET', 'HEAD', 'OPTIONS']) assert.equal(fromOtherInstance(req(m, 'old'), 'new'), false, m);
});

test('the server says which start it is first, and refuses a write from another', async () => {
  // The writes that are let through really land, so give them a project of
  // their own (the default root is the process's cwd — the repo).
  const proj = mkdtempSync(join(tmpdir(), 'magictex-instance-'));
  writeFileSync(join(proj, 'main.tex'), 'original');
  const savedRoot = getProjectRoot();
  setProjectRoot(proj);
  const preview = await startPreviewServer();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${preview.port}`);
    const first = await new Promise<{ type: string; instance?: string }>((resolve, reject) => {
      ws.once('message', (d) => resolve(JSON.parse(String(d))));
      ws.once('error', reject);
    });
    ws.close();
    assert.equal(first.type, 'hello');
    assert.ok(first.instance, 'hello carries an id');

    const put = (sent?: string) => fetch(`${preview.url}/api/file?path=main.tex&compile=0`, {
      method: 'PUT',
      body: 'x',
      headers: { Origin: preview.url, ...(sent === undefined ? {} : { [INSTANCE_HEADER]: sent }) },
    });
    const stale = await put('some-other-server');
    assert.equal(stale.status, 409);
    assert.equal(stale.headers.get(STALE_HEADER), '1');
    assert.equal(readFileSync(join(proj, 'main.tex'), 'utf8'), 'original', 'the refused write left the file alone');
    assert.equal((await put(first.instance)).status, 200);
    assert.equal(readFileSync(join(proj, 'main.tex'), 'utf8'), 'x');
    assert.equal((await put()).status, 200);
  } finally {
    await preview.close();
    setProjectRoot(savedRoot);
  }
});
