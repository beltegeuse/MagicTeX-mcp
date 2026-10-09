// Text-match "SyncTeX" between the PDF and the source. The matching itself is
// shared with the server, which uses it to tell the agent where a comment's
// quote lives — see ../../src/preview/textMatch.ts.
export * from '../../src/preview/textMatch';
// Which occurrence of a repeated quote a comment is on, as the server decides it.
export { occurrenceOn, CONTEXT_CHARS } from '../../src/preview/reanchor';
