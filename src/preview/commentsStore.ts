// LiquidText-style anchored comments, stored per-project in
// .latex-preview/comments.json. The anchor is the quoted text + a little of the
// page text around it; the page number and the bounding rects (at scale 1, so
// highlights re-project at any zoom) are a cache of where that text was last
// found, refreshed after every compile (see reanchor.ts). The dir
// is already ignored by the file watcher and the project collector, so comment
// writes never trigger recompiles or end up in export zips.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { withLock } from '../lock.js';

export interface CommentRect { x: number; y: number; w: number; h: number }

// Status flow for the review workflow:
//   suggested — a reviewer agent proposed it; awaits the human's accept
//   accepted  — actionable (human comments start here); the author loop acts on these
//   resolved  — an author agent addressed it, with a note
// Renamed from 'pending' (confusingly read as "still awaiting your decision"
// when it actually meant the opposite: you already decided, the author hasn't
// acted yet) — this collision fooled both users and Claude's own summaries.
export type CommentStatus = 'suggested' | 'accepted' | 'resolved';
// Who raised a comment or wrote a reply. reviewer/defender are review agents;
// author is the revising agent; human is you.
export type CommentRole = 'human' | 'reviewer' | 'defender' | 'author';

export interface Reply { by: CommentRole; text: string; at: string }

export interface Comment {
  id: string;
  page: number;
  quote: string;
  rects: CommentRect[];
  text: string;
  status: CommentStatus;
  role?: CommentRole; // who raised it (default human)
  replies?: Reply[];  // a thread of follow-ups (human ↔ agents)
  created: string;
  resolvedNote?: string;
  resolvedAt?: string;
  /** Page text just before / after the quote, to tell repeated passages apart. */
  prefix?: string;
  suffix?: string;
  /** The quote was not found in the latest PDF: `page` is where it last was. */
  stale?: boolean;
}

const FILE = 'comments.json';

function storePath(root: string): string {
  return join(root, '.latex-preview', FILE);
}

/** The store exists but cannot be read. Never swallowed — see listComments. */
export class CommentStoreUnreadableError extends Error {
  constructor(path: string, cause: unknown) {
    super(
      `MagicTeX could not read ${path}: ${cause instanceof Error ? cause.message : String(cause)}. ` +
      'Refusing to touch it — writing now would replace every comment it holds. ' +
      'Fix or move the file, then try again.',
    );
    this.name = 'CommentStoreUnreadableError';
  }
}

/**
 * Every comment in this project.
 *
 * Two rules, both learned the hard way.
 *
 * **A read never writes.** This used to persist its normalisation from inside a
 * read, with no lock — and since `addComment` never set `replies`, the
 * "one-time upgrade" was re-triggered by every freshly added comment, so it ran
 * on essentially every read. A reader would load [c1,c2]; another agent would
 * take the lock and save [c1,c2,c3]; the reader's unlocked save then put
 * [c1,c2] back. c3 was gone, after its author had already been told it landed.
 * Normalising in memory costs nothing and persists on the next real write,
 * which does hold the lock.
 *
 * **A missing file is not an unreadable one.** A blanket catch returned [] for
 * both, and the next mutator wrote that [] over the file — so one transient
 * EACCES, one hand-edit with a stray comma, or one stale `.tmp-*` renamed in
 * destroyed every comment atomically and silently, and the caller got a 200.
 * Only ENOENT now means "none yet"; anything else throws.
 */
export async function listComments(root: string): Promise<Comment[]> {
  const path = storePath(root);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; // no comments yet
    throw new CommentStoreUnreadableError(path, e);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CommentStoreUnreadableError(path, e);
  }
  if (!Array.isArray(parsed)) {
    throw new CommentStoreUnreadableError(path, new Error('expected a JSON array of comments'));
  }

  // Normalised in memory only. This file is plain JSON in the user's project: it
  // can be hand-edited, written by an older version, or produced by an agent, so
  // returning it as Comment[] unchecked is a claim the type system cannot make —
  // and one missing `rects` was once enough to take down the whole PDF pane.
  for (const c of parsed as Comment[]) {
    if (!c) continue;
    if ((c.status as string) === 'pending') c.status = 'accepted'; // pre-rename files
    if (!Array.isArray(c.rects)) c.rects = [];
    if (!Array.isArray(c.replies)) c.replies = [];
    if (typeof c.prefix !== 'string') delete c.prefix;
    if (typeof c.suffix !== 'string') delete c.suffix;
  }
  return parsed as Comment[];
}

// Atomic write (temp file + rename): a concurrent listComments() from another
// process/agent then always sees either the fully-old or fully-new file, never
// a truncated one mid-write — true regardless of the lock below, which exists
// for a different problem (see withLock callers): two WRITERS racing to read
// the pre-edit array, each appending their own change, and the second save()
// silently discarding the first agent's change ("lost update").
async function save(root: string, comments: Comment[]): Promise<void> {
  await mkdir(join(root, '.latex-preview'), { recursive: true });
  const dest = storePath(root);
  const tmp = `${dest}.tmp-${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, JSON.stringify(comments, null, 2), 'utf8');
  await rename(tmp, dest);
}

export async function addComment(
  root: string,
  input: {
    page: number; quote: string; rects: CommentRect[]; text: string; role?: CommentRole; status?: CommentStatus;
    prefix?: string; suffix?: string;
  },
): Promise<Comment> {
  const comment: Comment = {
    id: randomBytes(6).toString('hex'),
    page: Math.max(1, Math.floor(input.page || 1)),
    quote: String(input.quote).slice(0, 600),
    rects: (input.rects ?? []).slice(0, 40).map((r) => ({ x: +r.x, y: +r.y, w: +r.w, h: +r.h })),
    text: String(input.text).slice(0, 4000),
    status: input.status ?? 'accepted',
    role: input.role ?? 'human',
    // Written explicitly, so a new comment is already in the normalised shape.
    // Omitting it meant every fresh comment made the next read think the file
    // needed upgrading — which is what turned a one-time migration into a write
    // on almost every read.
    replies: [],
    created: new Date().toISOString(),
  };
  // Context is optional: an agent's comment gets it on its first re-anchoring.
  if (typeof input.prefix === 'string') comment.prefix = input.prefix.slice(-200);
  if (typeof input.suffix === 'string') comment.suffix = input.suffix.slice(0, 200);
  // The whole read -> mutate -> write runs as one cross-process critical
  // section, so two agents adding/resolving/replying to comments at the same
  // moment queue instead of one silently overwriting the other's change.
  await withLock(root, async () => {
    const all = await listComments(root);
    all.push(comment);
    await save(root, all);
  });
  return comment;
}

export async function updateComment(
  root: string,
  id: string,
  patch: { status?: CommentStatus; resolvedNote?: string; text?: string },
): Promise<Comment | null> {
  return withLock(root, async () => {
    const all = await listComments(root);
    const c = all.find((x) => x.id === id);
    if (!c) return null;
    if (patch.text !== undefined) c.text = String(patch.text).slice(0, 4000);
    if (patch.status) {
      c.status = patch.status;
      if (patch.status === 'resolved') c.resolvedAt = new Date().toISOString();
      else { delete c.resolvedAt; delete c.resolvedNote; }
    }
    if (patch.resolvedNote !== undefined) c.resolvedNote = String(patch.resolvedNote).slice(0, 2000);
    await save(root, all);
    return c;
  });
}

export async function addReply(
  root: string,
  id: string,
  reply: { by: CommentRole; text: string },
): Promise<Comment | null> {
  return withLock(root, async () => {
    const all = await listComments(root);
    const c = all.find((x) => x.id === id);
    if (!c) return null;
    (c.replies ??= []).push({ by: reply.by, text: String(reply.text).slice(0, 2000), at: new Date().toISOString() });
    await save(root, all);
    return c;
  });
}

/** Where a comment now is, as reanchorComments' callback reports it. */
export type AnchorUpdate = Partial<Pick<Comment, 'page' | 'rects' | 'prefix' | 'suffix' | 'stale'>>;

/**
 * Re-place every comment against a new PDF. `place` returns the fields that
 * changed for a comment (or null to leave it alone); a `stale: false` clears
 * the flag. Writes only if something actually changed, so a recompile that
 * moved nothing doesn't touch the file. Resolves to whether it did.
 */
export async function reanchorComments(root: string, place: (c: Comment) => AnchorUpdate | null): Promise<boolean> {
  return withLock(root, async () => {
    const all = await listComments(root);
    let changed = false;
    for (const c of all) {
      const u = place(c);
      if (!u) continue;
      if (u.page !== undefined && u.page !== c.page) { c.page = u.page; changed = true; }
      if (u.rects !== undefined && JSON.stringify(u.rects) !== JSON.stringify(c.rects)) { c.rects = u.rects; changed = true; }
      if (u.prefix !== undefined && u.prefix !== c.prefix) { c.prefix = u.prefix; changed = true; }
      if (u.suffix !== undefined && u.suffix !== c.suffix) { c.suffix = u.suffix; changed = true; }
      if (u.stale !== undefined && u.stale !== !!c.stale) {
        if (u.stale) c.stale = true; else delete c.stale;
        changed = true;
      }
    }
    if (changed) await save(root, all);
    return changed;
  });
}

export async function deleteComment(root: string, id: string): Promise<boolean> {
  return withLock(root, async () => {
    const all = await listComments(root);
    const next = all.filter((x) => x.id !== id);
    if (next.length === all.length) return false;
    await save(root, next);
    return true;
  });
}
