import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { dbPath, EMBEDDING_DIM } from './config.js';
import { redactSecrets } from './redact.js';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  mtime_ms REAL NOT NULL,
  size INTEGER NOT NULL,
  indexed_at TEXT NOT NULL,
  warnings INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  tool TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  cwd TEXT,
  project TEXT,
  title TEXT,
  started_at TEXT,
  ended_at TEXT,
  message_count INTEGER NOT NULL,
  preview TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source_path);
CREATE INDEX IF NOT EXISTS idx_sessions_tool ON sessions(tool);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  session_rowid INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  role TEXT NOT NULL,
  ts TEXT,
  text TEXT NOT NULL,
  hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_rowid);

-- trigram tokenizer: substring matching that also works for CJK text
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text,
  content='messages',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

-- embedding chunks (populated only when embeddings are enabled)
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL,
  session_rowid INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_message ON chunks(message_id);
CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_rowid);
`;

/** Stable content hash used for message-level incremental re-ingest.
 * Covers role + stored (post-truncation) text; position is matched via idx. */
export function messageHash(role: string, text: string): string {
  return createHash('sha1').update(role).update('\x00').update(text).digest('hex').slice(0, 16);
}

export function openDb(): DB {
  const db = new Database(dbPath());
  db.pragma('journal_mode = WAL');
  sqliteVec.load(db);
  db.exec(SCHEMA);
  migrateMessageHash(db);
  // vec0 virtual tables can't use IF NOT EXISTS on some versions; create lazily
  const hasVec = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'`)
    .get();
  if (!hasVec) {
    db.exec(`CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[${EMBEDDING_DIM}])`);
  }
  // after vec_chunks exists: this migration deletes stale vectors
  migrateRedactSecrets(db);
  return db;
}

/** Existing DBs predate the hash column: add it and backfill so the first
 * re-ingest after upgrading still keeps unchanged messages (and their vectors). */
function migrateMessageHash(db: DB): void {
  const cols = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
  if (cols.some((c) => c.name === 'hash')) return;
  db.exec(`ALTER TABLE messages ADD COLUMN hash TEXT`);
  const pairs: [string, number][] = [];
  for (const row of db.prepare(`SELECT id, role, text FROM messages`).iterate() as Iterable<{
    id: number;
    role: string;
    text: string;
  }>) {
    pairs.push([messageHash(row.role, row.text), row.id]);
  }
  const update = db.prepare(`UPDATE messages SET hash = ? WHERE id = ?`);
  db.transaction(() => {
    for (const [hash, id] of pairs) update.run(hash, id);
  })();
}

/** One-time cleanup: rows indexed before redaction existed may hold plaintext
 * credentials. Redact them in place, recompute hashes (so the next re-ingest —
 * which redacts before hashing — sees them as unchanged), and drop their
 * chunks/vectors (content changed → embeddings are stale; embedMissing re-embeds).
 * messages_fts only has INSERT/DELETE triggers, so a plain UPDATE of
 * messages.text would silently desync FTS — DELETE + re-INSERT instead. */
function migrateRedactSecrets(db: DB): void {
  if (db.prepare(`SELECT value FROM meta WHERE key = 'redact_v1'`).get()) return;
  const hits: {
    id: number;
    session_rowid: number;
    idx: number;
    role: string;
    ts: string | null;
    text: string;
  }[] = [];
  for (const row of db
    .prepare(`SELECT id, session_rowid, idx, role, ts, text FROM messages`)
    .iterate() as Iterable<(typeof hits)[number]>) {
    const clean = redactSecrets(row.text);
    if (clean !== row.text) hits.push({ ...row, text: clean });
  }
  const delVecs = db.prepare(
    `DELETE FROM vec_chunks WHERE rowid IN (SELECT id FROM chunks WHERE message_id = ?)`,
  );
  const delChunks = db.prepare(`DELETE FROM chunks WHERE message_id = ?`);
  const delMsg = db.prepare(`DELETE FROM messages WHERE id = ?`);
  const insMsg = db.prepare(
    `INSERT INTO messages (id, session_rowid, idx, role, ts, text, hash) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const updSession = db.prepare(`UPDATE sessions SET title = ?, preview = ? WHERE id = ?`);
  db.transaction(() => {
    for (const m of hits) {
      delVecs.run(m.id);
      delChunks.run(m.id);
      delMsg.run(m.id);
      insMsg.run(m.id, m.session_rowid, m.idx, m.role, m.ts, m.text, messageHash(m.role, m.text));
    }
    // titles/previews are derived from message text and can carry the same secrets
    for (const s of db
      .prepare(`SELECT id, title, preview FROM sessions`)
      .all() as { id: number; title: string | null; preview: string | null }[]) {
      const title = s.title === null ? null : redactSecrets(s.title);
      const preview = s.preview === null ? null : redactSecrets(s.preview);
      if (title !== s.title || preview !== s.preview) updSession.run(title, preview, s.id);
    }
    db.prepare(`INSERT INTO meta (key, value) VALUES ('redact_v1', ?)`).run(
      new Date().toISOString(),
    );
  })();
}

/** Remove a source file's session + messages + chunks + vectors (used before re-ingest). */
export function deleteSourceData(db: DB, sourcePath: string): void {
  const sessionRows = db
    .prepare(`SELECT id FROM sessions WHERE source_path = ?`)
    .all(sourcePath) as { id: number }[];
  const delChunkVecs = db.prepare(
    `DELETE FROM vec_chunks WHERE rowid IN (SELECT id FROM chunks WHERE session_rowid = ?)`,
  );
  const delChunks = db.prepare(`DELETE FROM chunks WHERE session_rowid = ?`);
  const delMessages = db.prepare(`DELETE FROM messages WHERE session_rowid = ?`);
  const delSession = db.prepare(`DELETE FROM sessions WHERE id = ?`);
  for (const { id } of sessionRows) {
    delChunkVecs.run(id);
    delChunks.run(id);
    delMessages.run(id);
    delSession.run(id);
  }
}
