// Right panel: the comments workspace and the review gate.
//   suggested — a reviewer agent proposed it; the human Accepts (→ accepted) or
//               Rejects it, unless "auto-accept" (copilot) is on.
//   accepted  — actionable; the author loop picks these up via check_comments.
//   resolved  — done, with the author's note.
// Clicking a card jumps to its highlight in the PDF.
import { useEffect, useState } from 'react';
import { patchComment, removeComment, replyComment, type Comment } from '../api';

function ReplyBox({ id }: { id: string }) {
  const [text, setText] = useState('');
  return (
    <form className="reply-box" onClick={(e) => e.stopPropagation()}
          onSubmit={(e) => { e.preventDefault(); if (text.trim()) { void replyComment(id, text.trim()); setText(''); } }}>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply…" />
      <button className="ghost tiny" disabled={!text.trim()}>send</button>
    </form>
  );
}

export function CommentsPanel({
  comments, selectedId, onJump,
}: {
  comments: Comment[];
  selectedId: string | null;
  onJump: (c: Comment) => void;
}) {
  const [auto, setAuto] = useState(() => localStorage.getItem('ws-auto-accept') === '1');
  useEffect(() => { localStorage.setItem('ws-auto-accept', auto ? '1' : '0'); }, [auto]);

  const suggested = comments.filter((c) => c.status === 'suggested');
  const accepted = comments.filter((c) => c.status === 'accepted');
  const resolved = comments.filter((c) => c.status === 'resolved');

  // Copilot mode: as reviewer suggestions arrive, accept them automatically.
  useEffect(() => {
    if (!auto) return;
    for (const c of suggested) void patchComment(c.id, { status: 'accepted' });
  }, [auto, suggested]);

  const accept = (c: Comment) => void patchComment(c.id, { status: 'accepted' });
  const reject = (c: Comment) => void removeComment(c.id);

  const card = (c: Comment) => (
    <div key={c.id} className={`comment ${c.id === selectedId ? 'sel' : ''} ${c.status}`} onClick={() => onJump(c)}>
      <div className="comment-quote">
        {c.role && c.role !== 'human' && <span className={`role-badge role-${c.role}`}>{c.role}</span>}
        p.{c.page} · “{c.quote.slice(0, 90)}{c.quote.length > 90 ? '…' : ''}”
        {c.stale && (
          <span className="stale-badge" title="The passage is no longer in the PDF; this page is an estimate.">page estimated</span>
        )}
        {c.current === '' && <span className="edit-badge" title="The quoted passage was deleted.">deleted</span>}
        {c.current && (
          <span className="edit-badge" title={`Now: ${c.current}`}>
            edited → “{c.current.slice(0, 60)}{c.current.length > 60 ? '…' : ''}”
          </span>
        )}
      </div>
      <div className="comment-text">{c.text}</div>
      {c.replies?.map((r, i) => (
        <div key={i} className="reply"><span className={`role-badge role-${r.by}`}>{r.by}</span>{r.text}</div>
      ))}
      {c.status === 'resolved' && c.resolvedNote && <div className="comment-note">✓ {c.resolvedNote}</div>}
      {c.status !== 'resolved' && <ReplyBox id={c.id} />}
      <div className="comment-actions" onClick={(e) => e.stopPropagation()}>
        {c.status === 'suggested' && <>
          <button className="on" onClick={() => accept(c)}>Accept</button>
          <button className="ghost" onClick={() => reject(c)}>Reject</button>
        </>}
        {c.status === 'accepted' && <>
          <button className="ghost" onClick={() => void patchComment(c.id, { status: 'resolved' })}>resolve</button>
          <button className="ghost" onClick={() => void removeComment(c.id)}>delete</button>
        </>}
        {c.status === 'resolved' && <>
          <button className="ghost" onClick={() => void patchComment(c.id, { status: 'accepted' })}>reopen</button>
          <button className="ghost" onClick={() => void removeComment(c.id)}>close</button>
        </>}
      </div>
    </div>
  );

  return (
    <div className="comments">
      <label className="auto-accept" title="Copilot: automatically accept reviewer suggestions so the loop resolves them without a manual gate">
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
        Auto-accept reviewer suggestions (copilot)
      </label>

      {comments.length === 0 && (
        <div className="panel-hint">
          Select text on the PDF and add a comment — or have a reviewer agent post them.
          Accepted comments become instructions the author loop picks up (“address my comments”).
        </div>
      )}

      {suggested.length > 0 && (
        <div className="comments-head suggested-head">
          Suggested · {suggested.length}
          <button className="ghost tiny" onClick={() => suggested.forEach(accept)}>accept all</button>
          <button className="ghost tiny" onClick={() => suggested.forEach(reject)}>reject all</button>
        </div>
      )}
      {suggested.map(card)}

      {accepted.length > 0 && <div className="comments-head">Accepted · {accepted.length}</div>}
      {accepted.map(card)}

      {resolved.length > 0 && (
        <div className="comments-head suggested-head">
          Resolved · {resolved.length}
          <button className="ghost tiny" onClick={() => resolved.forEach((c) => void removeComment(c.id))}>clear all</button>
        </div>
      )}
      {resolved.map(card)}
    </div>
  );
}
