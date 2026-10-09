// Text-match "SyncTeX" between the PDF and the source. The matching itself is
// shared with the server, which uses it to tell the agent where a comment's
// quote lives — see ../../src/preview/textMatch.ts.
export * from '../../src/preview/textMatch';
// Where a comment's passage is on a page — the right occurrence of a repeated
// quote, or what replaced it once edited — exactly as the server decides it.
export { locateOn, CONTEXT_CHARS } from '../../src/preview/reanchor';
