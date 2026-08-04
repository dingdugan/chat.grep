import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/** All chatgrep state lives under one directory (override with CHATGREP_DIR). */
export function dataDir(): string {
  const dir = process.env.CHATGREP_DIR ?? path.join(os.homedir(), '.chatgrep');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function dbPath(): string {
  return path.join(dataDir(), 'index.db');
}

export function modelCacheDir(): string {
  return path.join(dataDir(), 'models');
}

/** multilingual-e5-small: strong CJK + English retrieval quality at 384 dims.
 * Quantized (q8) to keep the one-time download ~110MB. E5 models require
 * "query: " / "passage: " prefixes — handled in embeddings.ts. */
export const EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';
export const EMBEDDING_DIM = 384;
export const EMBEDDING_DTYPE = 'q8';
/** messages shorter than this carry no retrieval value ("do it", "好的") */
export const MIN_EMBED_CHARS = 25;
