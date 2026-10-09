import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOWNLOADER_STDIO, busytexPackageVersion, ensureAssets } from '../src/engine/assets.js';
import { STAMP } from '../src/engine/assetsDir.js';

// texlyre-busytex 1.4.0's runner loads busytex_biber.js at init. A cache fetched
// for 1.2.x has busytex.wasm — so it looked "present" — but not that, and the
// engine failed to start for every existing user. The upstream downloader also
// skips any non-empty busytex/, so re-running it could not repair the cache.

/** A cache dir under MAGICTEX_ASSETS_DIR, optionally pre-filled with old assets. */
function withCache(fill: (dir: string) => void, body: (dir: string, root: string) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'assets-refresh-'));
    const dir = join(root, 'busytex');
    const prev = process.env.MAGICTEX_ASSETS_DIR;
    process.env.MAGICTEX_ASSETS_DIR = dir;
    try {
      fill(dir);
      await body(dir, root);
    } finally {
      if (prev === undefined) delete process.env.MAGICTEX_ASSETS_DIR;
      else process.env.MAGICTEX_ASSETS_DIR = prev;
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function oldAssets(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'busytex.wasm'), 'old wasm');
  writeFileSync(join(dir, 'only-in-old.txt'), 'x');
}

/** Behaves like `texlyre-busytex download-assets <dest>`: creates dest/busytex. */
function fakeDownloader(calls: string[]) {
  return async (dest: string) => {
    calls.push(dest);
    mkdirSync(join(dest, 'busytex'), { recursive: true });
    writeFileSync(join(dest, 'busytex', 'busytex.wasm'), 'new wasm');
    writeFileSync(join(dest, 'busytex', 'busytex_biber.js'), '');
  };
}

/** Swallows the progress lines ensureAssets writes to stderr. */
const quiet = (f: (dir: string, root: string) => Promise<void>) => async (dir: string, root: string) => {
  const err = console.error;
  console.error = () => {};
  try { await f(dir, root); } finally { console.error = err; }
};

test('assets without a stamp are replaced, stamped, and not fetched again', withCache(oldAssets, quiet(async () => {
  const dir = process.env.MAGICTEX_ASSETS_DIR!;
  const calls: string[] = [];
  await ensureAssets(fakeDownloader(calls));

  assert.equal(calls.length, 1);
  assert.equal(readFileSync(join(dir, 'busytex.wasm'), 'utf8'), 'new wasm');
  assert.ok(existsSync(join(dir, 'busytex_biber.js')));
  assert.ok(!existsSync(join(dir, 'only-in-old.txt')), 'the old tree must be replaced, not merged into');
  assert.equal(readFileSync(join(dir, STAMP), 'utf8').trim(), busytexPackageVersion());

  await ensureAssets(fakeDownloader(calls));
  assert.equal(calls.length, 1, 'stamped, current assets must not be downloaded again');
})));

test('assets stamped for another engine version are refreshed', withCache((dir) => {
  oldAssets(dir);
  writeFileSync(join(dir, STAMP), '1.2.3\n');
}, quiet(async () => {
  const calls: string[] = [];
  await ensureAssets(fakeDownloader(calls));
  assert.equal(calls.length, 1);
})));

test('the download lands beside the live dir, never in it, and leaves nothing behind', withCache(oldAssets, quiet(async (dir, root) => {
  const calls: string[] = [];
  await ensureAssets(fakeDownloader(calls));
  // Upstream no-ops on a non-empty busytex/, so the live dir is the one place it can't go.
  assert.notEqual(join(calls[0], 'busytex'), dir);
  assert.deepEqual(readdirSync(root), ['busytex'], 'no staging or .old dir left over');
})));

test('a failed download leaves the existing assets untouched', withCache(oldAssets, quiet(async (dir, root) => {
  await assert.rejects(ensureAssets(async (dest) => {
    mkdirSync(join(dest, 'busytex'), { recursive: true });
    throw new Error('network down');
  }), /asset download failed \(network down\)/);
  assert.equal(readFileSync(join(dir, 'busytex.wasm'), 'utf8'), 'old wasm');
  assert.deepEqual(readdirSync(root), ['busytex']);
})));

test('a download with no busytex.wasm in it is not swapped in', withCache(oldAssets, quiet(async (dir) => {
  await assert.rejects(ensureAssets(async (dest) => {
    mkdirSync(join(dest, 'busytex'), { recursive: true });
  }), /busytex\.wasm is missing/);
  assert.equal(readFileSync(join(dir, 'busytex.wasm'), 'utf8'), 'old wasm');
})));

test('a fresh install downloads into place', withCache(() => {}, quiet(async (dir) => {
  await ensureAssets(fakeDownloader([]));
  assert.equal(readFileSync(join(dir, STAMP), 'utf8').trim(), busytexPackageVersion());
})));

test("the downloader's stdout cannot reach ours — that is the MCP channel", () => {
  // The downloader prints progress with console.log. Run a child that does the
  // same with the stdio we give the real one, and check our stdout stays empty.
  const r = spawnSync(process.execPath, ['-e',
    `require('child_process').spawnSync(process.execPath, ['-e', 'console.log("Progress: 50%")'], { stdio: ${JSON.stringify(DOWNLOADER_STDIO)} })`,
  ], { encoding: 'utf8' });
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /Progress: 50%/);
});
