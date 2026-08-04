import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgrep-indexer-test-'));
process.env.CHATGREP_DIR = path.join(tmp, 'data');

// import AFTER setting CHATGREP_DIR (config reads it at call time, but keep ordering obvious)
const { openDb, messageHash } = await import('../src/db.js');
const { indexAdapter } = await import('../src/indexer.js');
const { claudeCodeAdapter } = await import('../src/adapters/claude-code.js');
const { EMBEDDING_DIM, MIN_EMBED_CHARS } = await import('../src/config.js');

const sessionFile = path.join(tmp, 'session.jsonl');

function ccLine(role: 'user' | 'assistant', text: string, minute: number): string {
  const content = role === 'assistant' ? [{ type: 'text', text }] : text;
  return JSON.stringify({
    type: role,
    sessionId: 's1',
    cwd: '/proj/foo',
    timestamp: `2026-01-01T00:0${minute}:00Z`,
    message: { role, content },
  });
}

function writeSession(lines: string[]): void {
  fs.writeFileSync(sessionFile, lines.join('\n'));
}

function fileEntry() {
  const st = fs.statSync(sessionFile);
  return { path: sessionFile, mtimeMs: st.mtimeMs, size: st.size };
}

const fakeAdapter = {
  tool: 'claude-code',
  displayName: 'Fake',
  discover: () => [fileEntry()],
  parse: claudeCodeAdapter.parse,
};

// texts long enough that embedMissing would consider them (>= MIN_EMBED_CHARS)
const T0 = 'how do I fix CORS in my local dev server setup?';
const T1 = 'Use a reverse proxy so browser and API share an origin.';
const T2 = 'that worked, thanks — can you also explain preflight requests?';
const T3 = 'Preflight is an OPTIONS request the browser sends before the real one.';
assert.ok([T0, T1, T2, T3].every((t) => t.length >= MIN_EMBED_CHARS));

test('re-ingest keeps unchanged messages (ids + chunks) and only new/changed ones need embedding', () => {
  writeSession([ccLine('user', T0, 0), ccLine('assistant', T1, 1), ccLine('user', T2, 2)]);
  const db = openDb();
  indexAdapter(db, fakeAdapter, false);

  const msgsBefore = db
    .prepare(`SELECT id, idx, text, hash FROM messages ORDER BY idx`)
    .all() as { id: number; idx: number; text: string; hash: string }[];
  assert.equal(msgsBefore.length, 3);
  assert.ok(msgsBefore.every((m) => m.hash && m.hash.length === 16));

  // simulate a completed embedding pass without downloading a model:
  // one chunk + one vector per message, like embedMissing would produce
  const insertChunk = db.prepare(
    `INSERT INTO chunks (message_id, session_rowid, text) VALUES (?, ?, ?)`,
  );
  const insertVec = db.prepare(`INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)`);
  const sessionRowid = (db.prepare(`SELECT id FROM sessions`).get() as { id: number }).id;
  for (const m of msgsBefore) {
    const { lastInsertRowid } = insertChunk.run(m.id, sessionRowid, m.text);
    insertVec.run(BigInt(lastInsertRowid), Buffer.from(new Float32Array(EMBEDDING_DIM).buffer));
  }

  // append one message (the common "session grew" case) and re-ingest
  writeSession([ccLine('user', T0, 0), ccLine('assistant', T1, 1), ccLine('user', T2, 2), ccLine('assistant', T3, 3)]);
  indexAdapter(db, fakeAdapter, false);

  const msgsAfter = db
    .prepare(`SELECT id, idx, text FROM messages ORDER BY idx`)
    .all() as { id: number; idx: number; text: string }[];
  assert.equal(msgsAfter.length, 4);
  // unchanged messages keep their original ids → their chunks/vectors survive
  assert.deepEqual(msgsAfter.slice(0, 3).map((m) => m.id), msgsBefore.map((m) => m.id));
  assert.equal((db.prepare(`SELECT count(*) AS n FROM chunks`).get() as { n: number }).n, 3);
  assert.equal((db.prepare(`SELECT count(*) AS n FROM vec_chunks`).get() as { n: number }).n, 3);

  // exactly ONE message would be (re-)embedded: the appended one
  const pending = db
    .prepare(
      `SELECT m.id, m.text FROM messages m
       WHERE length(m.text) >= ${MIN_EMBED_CHARS}
         AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.message_id = m.id)`,
    )
    .all() as { id: number; text: string }[];
  assert.equal(pending.length, 1);
  assert.equal(pending[0].text, T3);

  // session row was updated in place, not recreated
  const sess = db
    .prepare(`SELECT id, message_count FROM sessions`)
    .all() as { id: number; message_count: number }[];
  assert.equal(sess.length, 1);
  assert.equal(sess[0].id, sessionRowid);
  assert.equal(sess[0].message_count, 4);

  // a CHANGED message loses its old row + chunks and shows up as pending again
  const T1b = 'Actually, prefer configuring CORS headers on the API itself.';
  writeSession([ccLine('user', T0, 0), ccLine('assistant', T1b, 1), ccLine('user', T2, 2), ccLine('assistant', T3, 3)]);
  indexAdapter(db, fakeAdapter, false);
  const afterEdit = db
    .prepare(`SELECT id, idx, text FROM messages ORDER BY idx`)
    .all() as { id: number; idx: number; text: string }[];
  assert.equal(afterEdit.length, 4);
  assert.equal(afterEdit[0].id, msgsBefore[0].id); // untouched neighbors keep ids
  assert.equal(afterEdit[2].id, msgsBefore[2].id);
  assert.notEqual(afterEdit[1].id, msgsBefore[1].id); // edited row was replaced
  assert.equal(afterEdit[1].text, T1b);
  assert.equal((db.prepare(`SELECT count(*) AS n FROM chunks`).get() as { n: number }).n, 2);
  assert.equal((db.prepare(`SELECT count(*) AS n FROM vec_chunks`).get() as { n: number }).n, 2);

  // FTS stayed in sync through keep/delete/insert: new text found, old text gone
  const hit = db
    .prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?`)
    .all('"prefer configuring CORS"');
  assert.equal(hit.length, 1);
  const gone = db
    .prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?`)
    .all('"reverse proxy"');
  assert.equal(gone.length, 0);

  db.close();
});

test('idx gaps from retroactive row deletion do not shift-match later messages', () => {
  // state from previous test: 4 messages [T0, T1b, T2, T3]; msg0 and msg2 have chunks
  const db = openDb();
  const before = db
    .prepare(`SELECT id, idx, text FROM messages ORDER BY idx`)
    .all() as { id: number; idx: number; text: string }[];
  assert.equal(before.length, 4);

  // simulate the historical artifact cleanup: delete a middle row (and its
  // chunks) straight from the DB while the source file still contains it
  const victim = before[2];
  db.prepare(`DELETE FROM vec_chunks WHERE rowid IN (SELECT id FROM chunks WHERE message_id = ?)`).run(victim.id);
  db.prepare(`DELETE FROM chunks WHERE message_id = ?`).run(victim.id);
  db.prepare(`DELETE FROM messages WHERE id = ?`).run(victim.id);

  indexAdapter(db, fakeAdapter, true); // force: file itself is unchanged

  const after = db
    .prepare(`SELECT id, idx, text FROM messages ORDER BY idx`)
    .all() as { id: number; idx: number; text: string }[];
  assert.equal(after.length, 4);
  assert.deepEqual(after.map((m) => m.idx), [0, 1, 2, 3]);
  // rows after the gap keep their ids (hash match, not position match)
  assert.equal(after[0].id, before[0].id);
  assert.equal(after[1].id, before[1].id);
  assert.equal(after[3].id, before[3].id);
  // only the retroactively-deleted message was reinserted
  assert.notEqual(after[2].id, victim.id);
  assert.equal(after[2].text, victim.text);
  // msg0's chunk survived; only the reinserted message lacks chunks
  const chunkOwners = db
    .prepare(`SELECT DISTINCT message_id FROM chunks ORDER BY message_id`)
    .all() as { message_id: number }[];
  assert.deepEqual(chunkOwners.map((c) => c.message_id), [before[0].id]);
  db.close();
});

test('hash column migration backfills existing rows', () => {
  const db = openDb();
  // simulate a pre-hash DB: drop the column, then reopen to trigger the migration
  db.exec(`ALTER TABLE messages DROP COLUMN hash`);
  db.close();
  const db2 = openDb();
  const rows = db2
    .prepare(`SELECT role, text, hash FROM messages`)
    .all() as { role: string; text: string; hash: string | null }[];
  assert.ok(rows.length > 0);
  for (const r of rows) assert.equal(r.hash, messageHash(r.role, r.text));
  db2.close();
});
