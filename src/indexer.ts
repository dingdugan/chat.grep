import path from 'node:path';
import type { DB } from './db.js';
import { deleteSourceData, messageHash } from './db.js';
import { adapters } from './adapters/index.js';
import { redactSecrets } from './redact.js';
import type { Adapter } from './types.js';

/** Guard against pathological sessions: a single message longer than this is truncated. */
const MAX_MESSAGE_CHARS = 200_000;

export interface IndexStats {
  tool: string;
  scanned: number;
  ingested: number;
  skipped: number;
  sessions: number;
  messages: number;
  warnings: number;
}

export function indexAll(
  db: DB,
  opts: { tools?: string[]; force?: boolean; onProgress?: (msg: string) => void } = {},
): IndexStats[] {
  const selected = opts.tools?.length
    ? adapters.filter((a) => opts.tools!.includes(a.tool))
    : adapters;
  return selected.map((a) => indexAdapter(db, a, opts.force ?? false, opts.onProgress));
}

export function indexAdapter(
  db: DB,
  adapter: Adapter,
  force: boolean,
  onProgress?: (msg: string) => void,
): IndexStats {
  const stats: IndexStats = {
    tool: adapter.tool,
    scanned: 0,
    ingested: 0,
    skipped: 0,
    sessions: 0,
    messages: 0,
    warnings: 0,
  };
  const files = adapter.discover();
  stats.scanned = files.length;

  const getFile = db.prepare(`SELECT mtime_ms, size FROM files WHERE path = ?`);
  const upsertFile = db.prepare(
    `INSERT INTO files (path, tool, mtime_ms, size, indexed_at, warnings)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET mtime_ms=excluded.mtime_ms, size=excluded.size,
       indexed_at=excluded.indexed_at, warnings=excluded.warnings`,
  );
  const insertSession = db.prepare(
    `INSERT INTO sessions (tool, session_id, source_path, cwd, project, title, started_at, ended_at, message_count, preview)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateSession = db.prepare(
    `UPDATE sessions SET tool=?, session_id=?, cwd=?, project=?, title=?, started_at=?, ended_at=?,
       message_count=?, preview=? WHERE id = ?`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO messages (session_rowid, idx, role, ts, text, hash) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const selectSessionIds = db.prepare(`SELECT id FROM sessions WHERE source_path = ?`);
  const selectOldMessages = db.prepare(
    `SELECT id, hash FROM messages WHERE session_rowid = ? ORDER BY idx`,
  );
  const updateMessagePos = db.prepare(`UPDATE messages SET idx = ?, ts = ? WHERE id = ?`);
  const delMessageVecs = db.prepare(
    `DELETE FROM vec_chunks WHERE rowid IN (SELECT id FROM chunks WHERE message_id = ?)`,
  );
  const delMessageChunks = db.prepare(`DELETE FROM chunks WHERE message_id = ?`);
  const delMessage = db.prepare(`DELETE FROM messages WHERE id = ?`);

  const ingestOne = db.transaction((file: { path: string; mtimeMs: number; size: number }) => {
    const session = adapter.parse(file.path);
    let warnings = 0;
    if (session && session.messages.length > 0) {
      // normalize first: hashes must cover the text exactly as stored,
      // and redaction must happen before hashing or every message containing
      // a secret would look "changed" on each re-ingest and re-embed forever
      const msgs = session.messages.map((m) => {
        const clean = redactSecrets(m.text);
        const text =
          clean.length > MAX_MESSAGE_CHARS
            ? clean.slice(0, MAX_MESSAGE_CHARS) + '\n…[truncated by chatgrep]'
            : clean;
        return { role: m.role, ts: m.timestamp, text, hash: messageHash(m.role, text) };
      });
      const title = session.title ? redactSecrets(session.title) : session.title;
      const firstUser = msgs.find((m) => m.role === 'user');
      const preview = (title ?? firstUser?.text ?? msgs[0].text)
        .replace(/\s+/g, ' ')
        .slice(0, 200);
      const project = session.cwd ? path.basename(session.cwd) : null;

      const existing = selectSessionIds.all(file.path) as { id: number }[];
      let sessionRowid: number | bigint;
      // new-message position -> old row id to reuse (its chunks/vec_chunks survive,
      // so embedMissing skips it)
      const reuse = new Map<number, number>();
      if (existing.length === 1) {
        sessionRowid = existing[0].id;
        updateSession.run(
          session.tool,
          session.sessionId,
          session.cwd,
          project,
          title,
          session.startedAt,
          session.endedAt,
          msgs.length,
          preview,
          sessionRowid,
        );
        // order-preserving match by content hash, NOT by position: stored idx can
        // have gaps (rows deleted retroactively, e.g. artifact cleanup) and logs
        // occasionally get lines inserted, which would shift every later position
        const old = selectOldMessages.all(sessionRowid) as { id: number; hash: string | null }[];
        const byHash = new Map<string, { id: number }[]>();
        for (const row of old) {
          if (!row.hash) continue;
          const q = byHash.get(row.hash);
          if (q) q.push(row);
          else byHash.set(row.hash, [row]);
        }
        const reusedIds = new Set<number>();
        msgs.forEach((m, i) => {
          const q = byHash.get(m.hash);
          if (q && q.length > 0) {
            const row = q.shift()!;
            reuse.set(i, row.id);
            reusedIds.add(row.id);
          }
        });
        for (const row of old) {
          if (reusedIds.has(row.id)) continue;
          delMessageVecs.run(row.id);
          delMessageChunks.run(row.id);
          delMessage.run(row.id);
        }
      } else {
        // 0 or >1 sessions for this path: rebuild from scratch
        deleteSourceData(db, file.path);
        const res = insertSession.run(
          session.tool,
          session.sessionId,
          session.sourcePath,
          session.cwd,
          project,
          title,
          session.startedAt,
          session.endedAt,
          msgs.length,
          preview,
        );
        sessionRowid = res.lastInsertRowid;
      }
      msgs.forEach((m, i) => {
        const oldId = reuse.get(i);
        if (oldId !== undefined) updateMessagePos.run(i, m.ts, oldId);
        else insertMessage.run(sessionRowid, i, m.role, m.ts, m.text, m.hash);
      });
      stats.sessions++;
      stats.messages += msgs.length;
      warnings = session.warnings;
    } else {
      deleteSourceData(db, file.path);
    }
    upsertFile.run(file.path, adapter.tool, file.mtimeMs, file.size, new Date().toISOString(), warnings);
    stats.warnings += warnings;
  });

  for (const file of files) {
    const prev = getFile.get(file.path) as { mtime_ms: number; size: number } | undefined;
    if (!force && prev && prev.mtime_ms === file.mtimeMs && prev.size === file.size) {
      stats.skipped++;
      continue;
    }
    try {
      ingestOne(file);
      stats.ingested++;
      if (stats.ingested % 50 === 0) {
        onProgress?.(`${adapter.displayName}: ${stats.ingested} files ingested…`);
      }
    } catch (err) {
      stats.warnings++;
      onProgress?.(`WARN ${adapter.displayName}: failed to ingest ${file.path}: ${err}`);
    }
  }
  return stats;
}
