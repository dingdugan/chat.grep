import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgrep-redact-test-'));
process.env.CHATGREP_DIR = path.join(tmp, 'data');

const { redactSecrets } = await import('../src/redact.js');
const { openDb, messageHash } = await import('../src/db.js');
const { indexAdapter } = await import('../src/indexer.js');
const { claudeCodeAdapter } = await import('../src/adapters/claude-code.js');

// fabricated, pattern-shaped only — none of these are real credentials
const FAKE = {
  anthropic: 'sk-ant-api03-' + 'Ab1_'.repeat(20),
  openai: 'sk-proj4' + 'x1Yz'.repeat(10),
  ghp: 'ghp_' + 'A1b2C3d4E5'.repeat(4),
  ghpat: 'github_pat_' + '11AAAAAAA0'.repeat(6),
  aws: 'AKIA' + 'IOSFODNN7EXAMPLE',
  slack: 'xoxb-2222222222-3333333333333-' + 'aBcDeFgHiJkLmNoPqRsT',
  google: 'AIzaSy' + 'D-1234567890abcdefghijklmnopqrstuv',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P',
};

test('redactSecrets: each credential kind is replaced, keeping the first 6 chars', () => {
  const cases: [string, string][] = [
    [FAKE.anthropic, 'anthropic-api-key'],
    [FAKE.openai, 'api-key'],
    [FAKE.ghp, 'github-token'],
    [FAKE.ghpat, 'github-token'],
    [FAKE.aws, 'aws-access-key-id'],
    [FAKE.slack, 'slack-token'],
    [FAKE.google, 'google-api-key'],
    [FAKE.jwt, 'jwt'],
  ];
  for (const [secret, kind] of cases) {
    const out = redactSecrets(`before ${secret} after`);
    assert.equal(out, `before ${secret.slice(0, 6)}…[REDACTED:${kind}] after`, kind);
  }
});

test('redactSecrets: bearer token after "Bearer " is redacted, header word kept', () => {
  const out = redactSecrets('Authorization: Bearer abcdefghij0123456789TOKEN');
  assert.equal(out, 'Authorization: Bearer abcdef…[REDACTED:bearer-token]');
});

test('redactSecrets: PEM private key block is redacted including body', () => {
  const pem = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEow' + 'x'.repeat(60), 'more+base64/lines==', '-----END RSA PRIVATE KEY-----'].join('\n');
  const out = redactSecrets(`here is my key:\n${pem}\ndone`);
  assert.ok(!out.includes('MIIEow' + 'x'), 'key body must be gone');
  assert.ok(out.includes('[REDACTED:private-key]'));
  assert.ok(out.endsWith('done'));
});

test('redactSecrets: multiple secrets in one message are all redacted', () => {
  const out = redactSecrets(`a=${FAKE.anthropic} b=${FAKE.aws} c=${FAKE.slack}`);
  assert.ok(!out.includes(FAKE.anthropic.slice(10)));
  assert.ok(!out.includes(FAKE.aws.slice(6)));
  assert.ok(!out.includes(FAKE.slack.slice(10)));
  assert.equal((out.match(/\[REDACTED:/g) ?? []).length, 3);
});

test('redactSecrets: normal text passes through untouched, and redaction is idempotent', () => {
  const plain = 'skiing is fun; sk-late night; ghp usage: Bearer of bad news; AKIAxyz too short';
  assert.equal(redactSecrets(plain), plain);
  const once = redactSecrets(`key: ${FAKE.anthropic}`);
  assert.equal(redactSecrets(once), once);
});

// --- ingest path: redaction happens before hashing, so re-ingest is stable ---

const sessionFile = path.join(tmp, 'session.jsonl');
const fakeAdapter = {
  tool: 'claude-code',
  displayName: 'Fake',
  discover: () => {
    const st = fs.statSync(sessionFile);
    return [{ path: sessionFile, mtimeMs: st.mtimeMs, size: st.size }];
  },
  parse: claudeCodeAdapter.parse,
};

function ccLine(role: 'user' | 'assistant', text: string): string {
  const content = role === 'assistant' ? [{ type: 'text', text }] : text;
  return JSON.stringify({ type: role, sessionId: 's1', cwd: '/p', message: { role, content } });
}

test('indexer: secrets are redacted before hashing → force re-ingest keeps row ids', () => {
  fs.writeFileSync(
    sessionFile,
    [ccLine('user', `my key is ${FAKE.anthropic}, please use it`), ccLine('assistant', 'never paste keys into chat')].join('\n'),
  );
  const db = openDb();
  indexAdapter(db, fakeAdapter, false);

  const rows = db
    .prepare(`SELECT id, role, text, hash FROM messages ORDER BY idx`)
    .all() as { id: number; role: string; text: string; hash: string }[];
  assert.equal(rows.length, 2);
  assert.ok(!rows[0].text.includes(FAKE.anthropic), 'stored text must be redacted');
  assert.ok(rows[0].text.includes('sk-ant…[REDACTED:anthropic-api-key]'));
  assert.equal(rows[0].hash, messageHash(rows[0].role, rows[0].text), 'hash covers stored (redacted) text');

  // force re-ingest of the same file: redacted messages must match by hash, not churn
  indexAdapter(db, fakeAdapter, true);
  const after = db.prepare(`SELECT id FROM messages ORDER BY idx`).all() as { id: number }[];
  assert.deepEqual(after.map((r) => r.id), rows.map((r) => r.id));

  // FTS finds the marker
  const hit = db.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'REDACTED'`).all();
  assert.equal(hit.length, 1);
  db.close();
});

// --- migration: pre-existing plaintext rows are cleaned on openDb ---

test('migration: existing plaintext secrets are redacted, FTS synced, chunks dropped', () => {
  const db = openDb();
  const sessionRowid = (db.prepare(`SELECT id FROM sessions`).get() as { id: number }).id;
  // simulate a pre-redaction DB: raw secret row + its chunk/vector + dirty preview
  const secretText = `run it with ${FAKE.ghp} as the token`;
  const { lastInsertRowid: msgId } = db
    .prepare(`INSERT INTO messages (session_rowid, idx, role, ts, text, hash) VALUES (?, 99, 'user', NULL, ?, ?)`)
    .run(sessionRowid, secretText, messageHash('user', secretText));
  const { lastInsertRowid: chunkId } = db
    .prepare(`INSERT INTO chunks (message_id, session_rowid, text) VALUES (?, ?, ?)`)
    .run(msgId, sessionRowid, secretText);
  db.prepare(`INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)`).run(
    BigInt(chunkId),
    Buffer.from(new Float32Array(384).buffer),
  );
  db.prepare(`UPDATE sessions SET preview = ? WHERE id = ?`).run(`asked about ${FAKE.ghp}`, sessionRowid);
  db.prepare(`DELETE FROM meta WHERE key = 'redact_v1'`).run();
  db.close();

  const db2 = openDb(); // migration runs here
  const row = db2
    .prepare(`SELECT role, text, hash FROM messages WHERE id = ?`)
    .get(msgId) as { role: string; text: string; hash: string };
  assert.ok(!row.text.includes(FAKE.ghp));
  assert.ok(row.text.includes('[REDACTED:github-token]'));
  assert.equal(row.hash, messageHash(row.role, row.text), 'hash recomputed on redacted text');
  // stale embeddings dropped → embedMissing will re-embed
  assert.equal((db2.prepare(`SELECT count(*) AS n FROM chunks WHERE message_id = ?`).get(msgId) as { n: number }).n, 0);
  assert.equal((db2.prepare(`SELECT count(*) AS n FROM vec_chunks WHERE rowid = ?`).get(BigInt(chunkId)) as { n: number }).n, 0);
  // FTS: marker searchable, plaintext gone (a plain UPDATE would have desynced this)
  // (FTS5 ignores a rowid= constraint combined with MATCH, so filter in JS)
  const marker = db2
    .prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'REDACTED'`)
    .all() as { rowid: number }[];
  assert.ok(marker.some((r) => r.rowid === Number(msgId)), 'marker searchable via FTS');
  const leaked = db2
    .prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?`)
    .all(`"${FAKE.ghp}"`);
  assert.equal(leaked.length, 0);
  const integrity = () => db2.exec(`INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)`);
  assert.doesNotThrow(integrity, 'FTS index consistent with content table');
  // derived session fields cleaned too
  const sess = db2.prepare(`SELECT preview FROM sessions WHERE id = ?`).get(sessionRowid) as { preview: string };
  assert.ok(!sess.preview.includes(FAKE.ghp));
  // flag set → second open is a no-op
  assert.ok(db2.prepare(`SELECT value FROM meta WHERE key = 'redact_v1'`).get());
  db2.close();
});
