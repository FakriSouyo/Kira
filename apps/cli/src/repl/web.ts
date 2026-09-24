import { createServer, type Server } from 'node:http';
import type { FinharnessDatabase } from '@harness/database';

/**
 * Tiny web preview (Phase 4, §28 GUI Vision Bridge).
 * Read-only: `GET /` (HTML), `GET /api/history`, `GET /api/run/:id`.
 * Tidak pakai framework — hanya `node:http`.
 */
export function createWebServer(db: FinharnessDatabase, opts: { port?: number } = {}): { server: Server; port: number } {
  const port = opts.port ?? 3280;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    try {
      if (url.pathname === '/') {
        const runs = await db.execution.listRuns({ limit: 20 });
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>Kira · History</title></head><body><h1>History (${runs.length})</h1><ul>${runs.map((r) => `<li><a href="/api/run/${r.id}">${r.id}</a> — ${r.ticker} — ${r.status}</li>`).join('')}</ul><p><a href="/api/history">/api/history</a></p></body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
        return;
      }
      if (url.pathname === '/api/history') {
        const runs = await db.execution.listRuns({ limit: 20 });
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(runs));
        return;
      }
      const runMatch = /^\/api\/run\/([^/]+)$/.exec(url.pathname);
      if (runMatch) {
        const id = decodeURIComponent(runMatch[1]);
        try {
          const art = await db.execution.getExecutionWithArtifacts(id);
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(art));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: msg }));
        }
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: msg }));
    }
  });
  return { server, port };
}
