import http from 'node:http';
import { spawn } from 'node:child_process';
import type { DB } from './db.js';
import { search } from './search.js';
import { indexAll } from './indexer.js';
import { findSession, exportMarkdown } from './export.js';
import { embedMissing, hasEmbeddings, modelIsCached } from './embeddings.js';
import { buildCorpus, buildPrompt, detectBackend, parseSince, runDistill } from './distill.js';
import { dbPath } from './config.js';
import { UI_HTML } from './ui.js';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** FTS snippet markers (\x01 \x02) → <mark>, everything else escaped */
function snippetHtml(snippet: string): string {
  return escapeHtml(snippet.replace(/\s+/g, ' '))
    .replace(/\x01/g, '<mark>')
    .replace(/\x02/g, '</mark>');
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function startServer(
  db: DB,
  opts: { port: number; open: boolean },
): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (url.pathname === '/') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(UI_HTML);
        return;
      }

      if (url.pathname === '/api/stats') {
        const rows = db
          .prepare(
            `SELECT tool, count(*) sessions, sum(message_count) messages,
                    min(started_at) first, max(ended_at) last
             FROM sessions GROUP BY tool`,
          )
          .all();
        const chunks = (db.prepare(`SELECT count(*) n FROM chunks`).get() as { n: number }).n;
        json(res, 200, { tools: rows, chunks, db: dbPath() });
        return;
      }

      if (url.pathname === '/api/recent') {
        const rows = db
          .prepare(
            `SELECT id AS sessionRowid, tool, session_id AS sessionId, project, title,
                    started_at AS ts, message_count AS messageCount, preview
             FROM sessions ORDER BY started_at DESC LIMIT 20`,
          )
          .all();
        json(res, 200, { sessions: rows });
        return;
      }

      if (url.pathname === '/api/search') {
        const q = url.searchParams.get('q')?.trim();
        if (!q) {
          json(res, 200, { hits: [], usedSemantic: false });
          return;
        }
        const mode = (url.searchParams.get('mode') ?? 'hybrid') as 'hybrid' | 'fts' | 'semantic';
        const { hits, usedSemantic, semanticSkippedReason } = await search(db, q, {
          limit: Number(url.searchParams.get('limit') ?? 20),
          tool: url.searchParams.get('tool') || undefined,
          project: url.searchParams.get('project') || undefined,
          mode,
        });
        json(res, 200, {
          usedSemantic,
          note: semanticSkippedReason,
          hits: hits.map((h) => ({
            ...h,
            snippet: undefined,
            snippetHtml: snippetHtml(h.snippet),
          })),
        });
        return;
      }

      const sessionMatch = /^\/api\/session\/([\w-]+)$/.exec(url.pathname);
      if (sessionMatch) {
        const session = findSession(db, sessionMatch[1]);
        if (!session) {
          json(res, 404, { error: 'session not found' });
          return;
        }
        const messages = db
          .prepare(
            `SELECT id, role, ts, text FROM messages WHERE session_rowid = ? ORDER BY idx`,
          )
          .all(session.id);
        json(res, 200, { session, messages });
        return;
      }

      const exportMatch = /^\/api\/export\/([\w-]+)$/.exec(url.pathname);
      if (exportMatch) {
        const session = findSession(db, exportMatch[1]);
        if (!session) {
          json(res, 404, { error: 'session not found' });
          return;
        }
        const md = exportMarkdown(db, session);
        const fname = `${session.tool}-${session.session_id.slice(0, 8)}.md`;
        res.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="${fname}"`,
        });
        res.end(md);
        return;
      }

      if (url.pathname === '/api/distill/preview') {
        const sinceIso = parseSince(url.searchParams.get('since') ?? '30d');
        const corpus = buildCorpus(db, sinceIso);
        let backend: { kind: string; claudePath?: string } | null = null;
        let backendError: string | null = null;
        try {
          backend = detectBackend();
        } catch (e) {
          backendError = (e as Error).message;
        }
        json(res, 200, {
          sinceIso,
          sessionCount: corpus.sessionCount,
          chars: corpus.chars,
          backend,
          backendError,
        });
        return;
      }

      if (url.pathname === '/api/distill' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { since } = JSON.parse(body || '{}');
        const sinceIso = parseSince(since ?? '30d');
        const corpus = buildCorpus(db, sinceIso);
        if (corpus.sessionCount === 0) {
          json(res, 400, { error: `no indexed sessions since ${sinceIso.slice(0, 10)}` });
          return;
        }
        // the POST itself is the user's explicit confirmation (the ui shows
        // exactly what will be sent before enabling the button)
        const backend = detectBackend();
        const report = await runDistill(buildPrompt(corpus), backend);
        json(res, 200, { report, sessionCount: corpus.sessionCount, chars: corpus.chars });
        return;
      }

      if (url.pathname === '/api/index' && req.method === 'POST') {
        const stats = indexAll(db);
        let embedded = 0;
        // top up embeddings for new messages only when the model is already local
        if (hasEmbeddings(db) && modelIsCached()) {
          embedded = await embedMissing(db);
        }
        json(res, 200, { stats, embedded });
        return;
      }

      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: String((err as Error).message ?? err) });
    }
  });

  const addr = `http://127.0.0.1:${opts.port}`;
  server.on('error', async (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // if the port holder is another chatgrep, treat it as already-running
      try {
        const resp = await fetch(`${addr}/api/stats`);
        if (resp.ok) {
          console.log(`chatgrep ui is already running → ${addr}`);
          if (opts.open && process.platform === 'darwin') {
            spawn('open', [addr], { stdio: 'ignore', detached: true }).unref();
          }
          process.exit(0);
        }
      } catch {
        /* port taken by something else */
      }
      console.error(
        `port ${opts.port} is in use by another program — try: chatgrep ui --port ${opts.port + 1}`,
      );
      process.exit(1);
    }
    throw err;
  });
  server.listen(opts.port, '127.0.0.1', () => {
    console.log(`chatgrep ui → ${addr}  (local only, Ctrl-C to stop)`);
    console.log(`tip: use the 127.0.0.1 address as-is; "localhost" may resolve to IPv6 and miss it`);
    if (opts.open && process.platform === 'darwin') {
      spawn('open', [addr], { stdio: 'ignore', detached: true }).unref();
    }
  });
  return server;
}
