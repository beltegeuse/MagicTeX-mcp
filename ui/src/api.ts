// Same-origin API helpers + the WebSocket live channel. The UI is served by the
// preview server itself, so everything is relative — no config, no CORS.
import { useEffect, useRef, useState } from 'react';

export interface Checkpoint {
  sha: string;
  time: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export type WsMessage =
  | { type: 'reload'; name?: string }
  | { type: 'compiling' }
  | { type: 'compile-error'; log: string }
  | { type: 'comments-changed' }
  // Sent once, as the server shuts down. This tab will never reach that server
  // again — and its contents are now history.
  | { type: 'server-closing' }
  // Sent first on every connection: which server start this is. A tab that
  // meets a different one (a restart on a pinned MAGICTEX_PORT, possibly for
  // another project) is talking to a server it was not loaded from.
  | { type: 'hello'; instance: string };

export interface CommentRect { x: number; y: number; w: number; h: number }
export type CommentStatus = 'suggested' | 'accepted' | 'resolved';
export type CommentRole = 'human' | 'reviewer' | 'defender' | 'author';
export interface Reply { by: CommentRole; text: string; at: string }
export interface Comment {
  id: string;
  page: number;
  quote: string;
  rects: CommentRect[];
  text: string;
  status: CommentStatus;
  role?: CommentRole;
  replies?: Reply[];
  created: string;
  resolvedNote?: string;
}

/**
 * Whether the server this page was loaded from has stopped for good.
 *
 * It lives here, not in a component, because every panel already goes through
 * this module and none of them were told. The dead-window banner was threaded to
 * the toolbar alone, so the editor kept autosaving into a closed port, History
 * kept offering a destructive restore, and Comments kept accepting replies —
 * each failing into a bare `catch` or no catch at all. One guard at the choke
 * point covers all of them.
 */
let serverGone = false;

export class ServerGoneError extends Error {
  constructor() {
    super('The MagicTeX server this window was connected to has stopped. Ask Claude to render a preview again — that opens a new window.');
    this.name = 'ServerGoneError';
  }
}

export function isServerGone(): boolean { return serverGone; }

/** Refuse a write that cannot land, with a message worth showing. */
function requireLive(): void {
  if (serverGone) throw new ServerGoneError();
}

// The id of the server this page was loaded from, once its socket said hello.
let instance: string | null = null;
// Told when a write finds the server gone, so the live channel says so too.
let onGone: (() => void) | null = null;
function markGone(): void {
  serverGone = true;
  onGone?.();
}

/**
 * Every state-changing request goes through here: it names this page's server,
 * so another server that has since taken the port refuses it (see the server's
 * instanceGuard.ts) — and that refusal is final for this window.
 */
async function writeFetch(url: string, init: RequestInit): Promise<Response> {
  requireLive();
  const headers = new Headers(init.headers);
  if (instance) headers.set('X-MagicTeX-Instance', instance);
  const r = await fetch(url, { ...init, headers });
  if (r.status === 409 && r.headers.get('X-MagicTeX-Stale')) { markGone(); throw new ServerGoneError(); }
  return r;
}
/** For the writes that report failure as a string rather than by throwing. */
async function writeOrMessage(url: string, init: RequestInit): Promise<Response | string> {
  try { return await writeFetch(url, init); } catch (e) {
    if (e instanceof ServerGoneError) return e.message;
    throw e;
  }
}

export async function fetchComments(): Promise<Comment[]> {
  const r = await fetch('/api/comments');
  return r.ok ? r.json() : [];
}

export async function createComment(input: { page: number; quote: string; rects: CommentRect[]; text: string }): Promise<void> {
  await writeFetch('/api/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
}

export async function patchComment(id: string, patch: { status?: CommentStatus; text?: string }): Promise<void> {
  await writeFetch(`/api/comments?id=${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
}

export async function removeComment(id: string): Promise<void> {
  await writeFetch(`/api/comments?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function replyComment(id: string, text: string): Promise<void> {
  await writeFetch(`/api/comments/reply?id=${encodeURIComponent(id)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, by: 'human' }),
  });
}

// `disconnected` is a hiccup worth retrying through; `stopped` means the server
// this tab was talking to is gone for good. They looked the same until a real
// bug report was filed off a dead tab — the pane was showing that server's last
// error while a live instance compiled the same paper fine on another port.
export type Status = 'connecting' | 'connected' | 'compiling' | 'ok' | 'error' | 'disconnected' | 'stopped';

export async function fetchCheckpoints(): Promise<Checkpoint[]> {
  const r = await fetch('/git/checkpoints');
  return r.ok ? r.json() : [];
}

export async function fetchDiff(sha: string): Promise<string> {
  const r = await fetch(`/git/diff?sha=${encodeURIComponent(sha)}`);
  return r.ok ? r.text() : '';
}

/** Restore the working tree to a checkpoint (revert). Returns an error string or null. */
export async function restoreCheckpoint(sha: string): Promise<string | null> {
  const r = await writeOrMessage(`/git/restore?sha=${encodeURIComponent(sha)}`, { method: 'POST' });
  if (typeof r === 'string') return r;
  return r.ok ? null : (await r.text()) || 'restore failed';
}

/** Restore a single file to a checkpoint version. Returns an error string or null. */
export async function restoreFile(sha: string, path: string): Promise<string | null> {
  const r = await writeOrMessage(`/git/restore-file?sha=${encodeURIComponent(sha)}&path=${encodeURIComponent(path)}`, { method: 'POST' });
  if (typeof r === 'string') return r;
  return r.ok ? null : (await r.text()) || 'restore failed';
}

/**
 * Where this project's history lives.
 *
 * Two ways to have none, and they need different answers: install git, or look
 * at a path. Reporting both as "no git found" sent people to install software
 * they already had, and left them nowhere to go once they had.
 *
 * The shell surfaces this outside the History tab, because a reader who never
 * opens that tab would otherwise never learn there is no record of what an
 * agent changed.
 */
export type HistoryMode = 'project' | 'shadow' | 'no-git' | 'unwritable';

export async function fetchGitStatus(): Promise<{ isRepo: boolean; mode: HistoryMode; detail?: string }> {
  try {
    const j = await (await fetch('/git/status')).json();
    return { isRepo: !!j.isRepo, mode: (j.mode as HistoryMode) ?? (j.isRepo ? 'project' : 'no-git'), detail: j.detail };
  } catch {
    return { isRepo: false, mode: 'no-git' };
  }
}

export async function fetchOverleafLink(): Promise<string | null> {
  try { return (await (await fetch('/overleaf/link')).json()).url ?? null; } catch { return null; }
}

export interface TreeNode { name: string; path: string; type: 'file' | 'dir'; editable?: boolean; children?: TreeNode[] }
export async function fetchTree(): Promise<TreeNode[]> {
  const r = await fetch('/api/tree');
  return r.ok ? r.json() : [];
}
/** Upload a figure/asset to `path` (relative to the project root). */
export async function uploadFile(path: string, file: File): Promise<string | null> {
  if (serverGone) return new ServerGoneError().message;
  const r = await writeOrMessage(`/api/upload?path=${encodeURIComponent(path)}`, { method: 'POST', body: await file.arrayBuffer() });
  if (typeof r === 'string') return r;
  return r.ok ? null : (await r.text()) || 'upload failed';
}
/** File-system op: mkfile | mkdir | rename | delete. Returns an error string or null. */
export async function fsOp(op: string, path: string, to?: string): Promise<string | null> {
  const r = await writeOrMessage('/api/fs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, path, to }),
  });
  if (typeof r === 'string') return r;
  return r.ok ? null : (await r.text()) || 'operation failed';
}

/**
 * Write a project file. `compile` is Ctrl+S / Save; a bare autosave passes false.
 *
 * The editor used to call `fetch` directly, so it was the one write with no
 * guard — and the one where failing silently costs the user their text rather
 * than a click.
 */
export async function saveFile(path: string, content: string, compile: boolean): Promise<void> {
  const r = await writeFetch(`/api/file?path=${encodeURIComponent(path)}&compile=${compile ? 1 : 0}`, {
    method: 'PUT', body: content,
  });
  if (!r.ok) throw new Error((await r.text()) || 'save failed');
}

/** Trigger a compile now (the toolbar's manual "Recompile"). */
export async function recompile(): Promise<void> {
  requireLive();
  try { await writeFetch('/api/recompile', { method: 'POST' }); } catch (e) { if (e instanceof ServerGoneError) throw e; /* otherwise ignore */ }
}

/** The document's \title{…} (from the main .tex) for the header, if any. */
export async function fetchDocTitle(): Promise<string | null> {
  try {
    const files: string[] = await (await fetch('/api/files')).json();
    for (const f of files) {
      if (!/\.tex$/i.test(f)) continue;
      const src = await (await fetch(`/api/file?path=${encodeURIComponent(f)}`)).text();
      if (!/\\documentclass/.test(src)) continue;
      const m = src.match(/\\title\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/);
      if (m) return m[1].replace(/\\\\|\\thanks\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim();
    }
  } catch { /* ignore */ }
  return null;
}

/** Live channel: connection state + a bump counter that increments on each reload. */
export function useLive(onMessage?: (m: WsMessage) => void) {
  const [status, setStatus] = useState<Status>('connecting');
  const [errorLog, setErrorLog] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  // Bumped by anything that ENDS a compile, success or failure. A caller that
  // records it before triggering one can then tell "my compile finished" from
  // "the status still says what the last compile left behind" — which a bare
  // `status === 'ok'` cannot, and which made the save chip declare success the
  // instant it was shown.
  const [compileSeq, setCompileSeq] = useState(0);
  const [pdfName, setPdfName] = useState('preview');
  const cbRef = useRef(onMessage);
  cbRef.current = onMessage;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;   // this component unmounted
    let farewell = false; // the server said goodbye — final, never retried
    let downSince = 0;    // wall clock, not an attempt count
    let retry: ReturnType<typeof setTimeout> | null = null;

    // Judged by elapsed time, not by number of attempts. Counting attempts
    // assumed each retry costs a second, which is false in two directions: a
    // slept laptop fires every overdue timer at once, so eleven failures could
    // land in a moment and declare a *live* server dead; and a hidden tab is
    // throttled to about one timer a minute, so ten attempts could span ten
    // minutes on a server that was already gone.
    const GIVE_UP_MS = 10_000;

    // A write refused as coming from another server's window: final, like a goodbye.
    onGone = () => { farewell = true; setStatus('stopped'); ws?.close(); };

    const connect = () => {
      ws = new WebSocket(`ws://${location.host}`);
      ws.onopen = () => {
        // Recovery. `stopped` used to latch with no way back, so one bad patch
        // of network left a working window permanently disabled until a manual
        // reload. A socket that opens is proof the server is there.
        downSince = 0;
        setStatus('connected');
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as WsMessage;
        if (msg.type === 'hello') {
          if (instance && msg.instance !== instance) {
            // Not the server this page came from — the port was taken over
            // after a crash. Nothing it says applies here; stop for good.
            farewell = true;
            serverGone = true;
            setStatus('stopped');
            ws?.close();
            return;
          }
          instance = msg.instance;
          return;
        }
        if (msg.type === 'server-closing') {
          // An explicit goodbye: no point retrying, and no point pretending the
          // pane's contents still mean anything.
          farewell = true;
          serverGone = true;
          setStatus('stopped');
          return;
        }
        if (msg.type === 'reload') {
          if (msg.name) setPdfName(String(msg.name).split(/[\\/]/).pop()!.replace(/\.tex$/i, '') || 'preview');
          setErrorLog('');
          setStatus('ok');
          setReloadTick((t) => t + 1);
          setCompileSeq((n) => n + 1);
        } else if (msg.type === 'compiling') {
          setStatus('compiling');
        } else if (msg.type === 'compile-error') {
          setStatus('error');
          setErrorLog(msg.log || 'compile failed');
          setCompileSeq((n) => n + 1);
        }
        cbRef.current?.(msg);
      };
      ws.onclose = () => {
        if (closed || farewell) return;
        downSince ||= Date.now();
        // Down long enough to say so — but keep retrying underneath. Retrying
        // forever *silently* is what made a dead tab look busy rather than
        // finished; giving up entirely is what made a live one unusable after a
        // network blip. Say "stopped", keep knocking.
        setStatus(Date.now() - downSince >= GIVE_UP_MS ? 'stopped' : 'disconnected');
        retry = setTimeout(connect, 1000);
      };
    };
    connect();
    return () => {
      closed = true;
      onGone = null;
      // The pending retry has to go too. Without this an unmount inside the
      // one-second window still fired connect(), opening a socket that nothing
      // owned or closed — leaked into the server's client set, where it then
      // held up the server's own shutdown.
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, []);

  return { status, errorLog, reloadTick, pdfName, compileSeq };
}
