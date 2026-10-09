import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { requestedPort, listenOn } from '../src/preview/listenPort.js';
import { startPreviewServer } from '../src/preview/previewServer.js';

// MAGICTEX_PORT pins the workspace URL so a dev server is recognisable and an
// open tab survives a reconnect. It must never cost a session its preview: a
// port that is taken falls back to a free one, and leaving it unset keeps the
// old behaviour — any free port — so servers in parallel sessions never clash.

const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

test('unset or empty MAGICTEX_PORT means any free port', () => {
  assert.equal(requestedPort(undefined), 0);
  assert.equal(requestedPort(''), 0);
  assert.equal(requestedPort('  '), 0);
});

test('a valid MAGICTEX_PORT is used as given', () => {
  assert.equal(requestedPort('47800'), 47800);
  assert.equal(requestedPort(' 47800 '), 47800);
});

test('a MAGICTEX_PORT that is not a port is rejected, not guessed at', () => {
  for (const raw of ['abc', '0', '-1', '65536', '80.5', '4780O']) assert.equal(requestedPort(raw), null, raw);
});

test('port 0 binds some free port', async () => {
  const s = createServer();
  const port = await listenOn(s, 0);
  assert.ok(port > 0);
  await close(s);
});

test('a free requested port is the one bound', async () => {
  // Borrow a port the OS says is free, release it, then ask for it by number.
  const probe = createServer();
  const free = await listenOn(probe, 0);
  await close(probe);
  const s = createServer();
  assert.equal(await listenOn(s, free), free);
  await close(s);
});

test('a requested port that is taken falls back to a free one', async () => {
  const holder = createServer();
  const taken = await listenOn(holder, 0);
  const s = createServer();
  const before = { error: s.listenerCount('error'), listening: s.listenerCount('listening') };
  try {
    const port = await listenOn(s, taken);
    assert.ok(port > 0 && port !== taken, `got ${port}, held ${taken}`);
    // The fallback must leave no stray listener behind for the next 'error'.
    assert.deepEqual({ error: s.listenerCount('error'), listening: s.listenerCount('listening') }, before);
  } finally {
    if (s.listening) await close(s);
    await close(holder);
  }
});

test('the preview server itself survives a taken MAGICTEX_PORT', async () => {
  // The unit above passed while the real server still crashed: ws re-emits the
  // HTTP server's 'error' on the WebSocketServer, which had no listener, so the
  // EADDRINUSE killed the process before the fallback ran. Only the whole
  // server shows that.
  const holder = createServer();
  const taken = await listenOn(holder, 0);
  const saved = process.env.MAGICTEX_PORT;
  process.env.MAGICTEX_PORT = String(taken);
  try {
    const preview = await startPreviewServer();
    assert.ok(preview.port > 0 && preview.port !== taken, `got ${preview.port}, held ${taken}`);
    await preview.close();
  } finally {
    if (saved === undefined) delete process.env.MAGICTEX_PORT; else process.env.MAGICTEX_PORT = saved;
    await close(holder);
  }
});
