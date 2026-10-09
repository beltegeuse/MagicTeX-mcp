// A tab left from a crashed server must never write into the next server that
// takes its port — which, with MAGICTEX_PORT pinned, can be another project's.
//
// After a crash there is no goodbye message, so the tab keeps knocking on the
// same URL. With random ports nothing else ever answers there; with a pinned
// one the next server does, and the tab's autosave would write its buffer into
// that project's file of the same name. So: kill server A outright, start
// server B for a different project on the same port, and try to save from A's
// tab. B's file must be untouched and the tab must say it has stopped.
//
//   node scripts/smoke-stale-tab.mjs
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

const project = (name, body) => {
  const dir = mkdtempSync(join(tmpdir(), `magictex-stale-${name}-`));
  writeFileSync(join(dir, 'main.tex'), [String.raw`\documentclass{article}`, String.raw`\begin{document}`, body, String.raw`\end{document}`, ''].join('\n'));
  return dir;
};
const projA = project('a', 'Project A.');
const projB = project('b', 'Project B.');
const bBefore = readFileSync(join(projB, 'main.tex'), 'utf8');

// A port that is free right now, for both servers to ask for.
const port = await new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const start = async (cwd) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, join(REPO, 'src', 'server.ts')],
    cwd,
    env: { ...process.env, MAGICTEX_PORT: String(port) },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'stale-tab-smoke', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  const r = await client.callTool({ name: 'render_preview', arguments: { backend: 'wasm' } }, undefined, { timeout: 15 * 60 * 1000 });
  const url = r.content.map((c) => c.text ?? '').join('\n').match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  return { client, transport, url };
};

const checks = [];
const check = (name, ok, detail) => { checks.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };

const a = await start(projA);
check('server A is on the pinned port', a.url === `http://127.0.0.1:${port}`, a.url);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
let b;
try {
  await page.goto(`${a.url}/app`, { waitUntil: 'load', timeout: 60_000 });
  await page.click('.tabs button:has-text("Source")').catch(() => {});
  await page.waitForSelector('.cm-content', { timeout: 60_000 });
  await page.waitForFunction(() => (document.querySelector('.cm-content')?.textContent ?? '').includes('Project A'), null, { timeout: 30_000 });

  // A crash, not a shutdown: no goodbye reaches the tab.
  process.kill(a.transport.pid, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 500));

  b = await start(projB);
  check('server B took the same port', b.url === a.url, b.url);

  // Give the tab time to reconnect to B and hear its hello.
  const stopped = await page.waitForSelector('text=has stopped', { timeout: 20_000 }).then(() => true, () => false);
  check('the old tab says its server has stopped', stopped);

  let puts = 0;
  page.on('request', (req) => { if (req.method() === 'PUT' && req.url().includes('/api/file')) puts++; });
  await page.click('.cm-content');
  await page.keyboard.press('End');
  await page.keyboard.type(' TYPED IN THE STALE TAB');
  await page.click('.editor-bar button:has-text("Save")').catch(() => {});
  await page.waitForTimeout(1500);
  const bAfter = readFileSync(join(projB, 'main.tex'), 'utf8');
  check("project B's file is untouched", bAfter === bBefore, bAfter === bBefore ? '' : `now: ${JSON.stringify(bAfter.slice(0, 120))}`);
  check('no save even left the stale tab', puts === 0, `${puts} PUT(s)`);
} finally {
  await browser.close();
  await b?.client.close();
  try { await a.client.close(); } catch { /* already killed */ }
}

const failed = checks.filter(([, ok]) => !ok);
console.log(failed.length ? `\nSMOKE FAIL: ${failed.length}` : '\nSMOKE PASS');
process.exit(failed.length ? 1 : 0);
