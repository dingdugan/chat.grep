import fs from 'node:fs';
import type { DB } from './db.js';
import { EMBEDDING_DTYPE, EMBEDDING_MODEL, MIN_EMBED_CHARS, modelCacheDir } from './config.js';

/** Local embeddings via transformers.js (ONNX, pure local inference).
 * The model (~25MB) is downloaded from HuggingFace ONCE, only after explicit
 * opt-in (--embed with confirmation, see cli). After that everything is offline. */

const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 150;
/** cap chunks per message so one pathological message can't dominate the index */
const MAX_CHUNKS_PER_MESSAGE = 8;

let pipelinePromise: Promise<(texts: string[]) => Promise<number[][]>> | null = null;

export function modelIsCached(): boolean {
  const dir = modelCacheDir();
  if (!fs.existsSync(dir)) return false;
  // transformers.js lays out <cacheDir>/<org>/<model>/...
  const marker = `${dir}/${EMBEDDING_MODEL}`;
  return fs.existsSync(marker) && fs.readdirSync(marker).length > 0;
}

async function getEmbedder(): Promise<(texts: string[]) => Promise<number[][]>> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      let transformers: any;
      try {
        transformers = await import('@huggingface/transformers');
      } catch {
        throw new Error(
          'Embeddings need the optional dependency @huggingface/transformers. Install it with: npm install @huggingface/transformers',
        );
      }
      transformers.env.cacheDir = modelCacheDir();
      const pipe = await transformers.pipeline('feature-extraction', EMBEDDING_MODEL, {
        dtype: EMBEDDING_DTYPE,
      });
      return async (texts: string[]) => {
        const out = await pipe(texts, { pooling: 'mean', normalize: true });
        const [n, dim] = [out.dims[0], out.dims[1]];
        const data: number[] = Array.from(out.data as Float32Array);
        const rows: number[][] = [];
        for (let i = 0; i < n; i++) rows.push(data.slice(i * dim, (i + 1) * dim));
        return rows;
      };
    })();
  }
  return pipelinePromise;
}

export function chunkText(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length && chunks.length < MAX_CHUNKS_PER_MESSAGE) {
    chunks.push(text.slice(start, start + CHUNK_CHARS));
    start += CHUNK_CHARS - CHUNK_OVERLAP;
  }
  return chunks;
}

export async function embedQuery(query: string): Promise<Float32Array> {
  const embed = await getEmbedder();
  // E5 models require asymmetric prefixes: "query: " vs "passage: "
  const [vec] = await embed([`query: ${query}`]);
  return Float32Array.from(vec);
}

/** Embed all messages that don't have chunks yet. Returns number of chunks added. */
export async function embedMissing(
  db: DB,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  // vectors from a different model are meaningless — wipe them on model change
  // (missing stamp + existing chunks = pre-stamp index, also wipe)
  const stamped = db.prepare(`SELECT value FROM meta WHERE key = 'embed_model'`).get() as
    | { value: string }
    | undefined;
  if (stamped?.value !== EMBEDDING_MODEL && hasEmbeddings(db)) {
    db.exec(`DELETE FROM vec_chunks; DELETE FROM chunks;`);
  }
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('embed_model', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(EMBEDDING_MODEL);

  const pending = db
    .prepare(
      `SELECT m.id, m.session_rowid, m.text FROM messages m
       WHERE length(m.text) >= ${MIN_EMBED_CHARS}
         AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.message_id = m.id)`,
    )
    .all() as { id: number; session_rowid: number; text: string }[];
  if (pending.length === 0) return 0;

  const embed = await getEmbedder();
  const insertChunk = db.prepare(
    `INSERT INTO chunks (message_id, session_rowid, text) VALUES (?, ?, ?)`,
  );
  const insertVec = db.prepare(`INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)`);

  let added = 0;
  const BATCH = 32;
  // build (message, chunk) pairs lazily in batches to bound memory
  const queue: { messageId: number; sessionRowid: number; text: string }[] = [];
  for (const m of pending) {
    for (const c of chunkText(m.text)) {
      queue.push({ messageId: m.id, sessionRowid: m.session_rowid, text: c });
    }
  }
  for (let i = 0; i < queue.length; i += BATCH) {
    const batch = queue.slice(i, i + BATCH);
    const vectors = await embed(batch.map((b) => `passage: ${b.text}`));
    const tx = db.transaction(() => {
      batch.forEach((b, j) => {
        const { lastInsertRowid } = insertChunk.run(b.messageId, b.sessionRowid, b.text);
        // sqlite-vec rejects rowids bound as doubles — must bind as int64
        insertVec.run(BigInt(lastInsertRowid), Buffer.from(Float32Array.from(vectors[j]).buffer));
      });
    });
    tx();
    added += batch.length;
    onProgress?.(Math.min(i + BATCH, queue.length), queue.length);
  }
  return added;
}

export function hasEmbeddings(db: DB): boolean {
  const row = db.prepare(`SELECT count(*) AS n FROM chunks`).get() as { n: number };
  return row.n > 0;
}
