// A workspace tab may only change the project of the server it was loaded from.
//
// A tab whose server crashed (no goodbye message) keeps retrying its socket on
// the same URL. With random ports nothing else ever answers there; with a
// pinned MAGICTEX_PORT the next server does — possibly for another project —
// and the old tab's 30 s autosave would then write its buffer into that
// project's file of the same name. So every server start gets an id, the tab
// learns it on connect and sends it with every write, and a write naming
// another server is refused. The tab also stops itself the moment it meets a
// server with a different id; this check covers a write that races that.
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** Sent by the workspace with every state-changing request. */
export const INSTANCE_HEADER = 'x-magictex-instance';
/** Set on the refusal, so the tab can tell it from any other 409. */
export const STALE_HEADER = 'x-magictex-stale';

export function newInstanceId(): string {
  return randomUUID();
}

/**
 * True when a state-changing request says it comes from a tab of another
 * server. A request without the header is let through: the legacy viewer and a
 * tab that has not heard the id yet (it was loaded from this server) send none.
 */
export function fromOtherInstance(req: IncomingMessage, instance: string): boolean {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  const sent = req.headers[INSTANCE_HEADER];
  return typeof sent === 'string' && sent !== '' && sent !== instance;
}
