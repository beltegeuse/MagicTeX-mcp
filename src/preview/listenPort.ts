// Which port the preview server binds.
//
// By default any free one (port 0): several MagicTeX servers — one per Claude
// session — run side by side, and a fixed default would make the second fail.
// `MAGICTEX_PORT` asks for a specific port instead, so the workspace URL stays
// the same across restarts (refresh the tab after one) and its per-origin
// settings — panel widths, Live, Visual — survive them. A tab left open from an
// earlier start does not come back to life on the new server: a clean shutdown
// ends it for good, and after a crash instanceGuard.ts stops it writing into a
// server it was not loaded from. It is a request, not a requirement — a port
// that is taken falls back to a free one rather than leaving the session
// without a preview.
import type { Server } from 'node:http';

/** The port `MAGICTEX_PORT` asks for: 0 when unset, null when it is not a port. */
export function requestedPort(raw: string | undefined = process.env.MAGICTEX_PORT): number | null {
  if (raw === undefined || raw.trim() === '') return 0;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/**
 * Listen on `port` (0 = any free port), falling back to a free port when that
 * one is taken or not allowed. Resolves with the port actually bound.
 */
export function listenOn(server: Server, port: number, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (p: number) => {
      const onError = (e: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (p !== 0 && (e.code === 'EADDRINUSE' || e.code === 'EACCES')) attempt(0);
        else reject(e);
      };
      const onListening = () => {
        server.off('error', onError);
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, host);
    };
    attempt(port);
  });
}
