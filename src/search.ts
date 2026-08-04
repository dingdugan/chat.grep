import type { DB } from './db.js';
import { embedQuery, hasEmbeddings } from './embeddings.js';

export interface SearchHit {
  messageId: number;
  sessionRowid: number;
  tool: string;
  sessionId: string;
  sourcePath: string;
  project: string | null;
  title: string | null;
  role: string;
  ts: string | null;
  snippet: string;
  score: number;
  matchedBy: ('fts' | 'semantic')[];
  /** additional matching messages in the same session (results are deduped per session) */
  extraHits: number;
}

export interface SearchOptions {
  limit?: number;
  tool?: string;
  project?: string;
  since?: string; // ISO date lower bound
  mode?: 'hybrid' | 'fts' | 'semantic';
}

interface RankedRow {
  messageId: number;
  rank: number;
  snippet: string;
  via: 'fts' | 'semantic';
}

const RRF_K = 60;
const CANDIDATES = 50;

function ftsSearch(db: DB, query: string, candidates: number): RankedRow[] {
  // trigram tokenizer needs >= 3 chars; fall back to LIKE for shorter queries
  if ([...query].length < 3) {
    const rows = db
      .prepare(
        `SELECT id AS messageId, substr(text, max(1, instr(lower(text), lower(?)) - 80), 240) AS snippet
         FROM messages WHERE text LIKE '%' || ? || '%' LIMIT ?`,
      )
      .all(query, query, candidates) as { messageId: number; snippet: string }[];
    return rows.map((r, i) => ({ messageId: r.messageId, rank: i + 1, snippet: r.snippet, via: 'fts' }));
  }
  // quote the query so FTS5 treats it as a string, not query syntax
  const quoted = `"${query.replace(/"/g, '""')}"`;
  try {
    const rows = db
      .prepare(
        `SELECT rowid AS messageId,
                snippet(messages_fts, 0, '\x01', '\x02', '…', 32) AS snippet
         FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(quoted, candidates) as { messageId: number; snippet: string }[];
    return rows.map((r, i) => ({ messageId: r.messageId, rank: i + 1, snippet: r.snippet, via: 'fts' }));
  } catch {
    return [];
  }
}

async function semanticSearch(db: DB, query: string, candidates: number): Promise<RankedRow[]> {
  const qvec = await embedQuery(query);
  const rows = db
    .prepare(
      `SELECT c.message_id AS messageId, c.text AS snippet, v.distance
       FROM vec_chunks v JOIN chunks c ON c.id = v.rowid
       WHERE v.embedding MATCH ? AND k = ?
       ORDER BY v.distance`,
    )
    .all(Buffer.from(qvec.buffer), candidates) as {
    messageId: number;
    snippet: string;
    distance: number;
  }[];
  // several chunks can point at the same message — keep the best
  const seen = new Set<number>();
  const out: RankedRow[] = [];
  for (const r of rows) {
    if (seen.has(r.messageId)) continue;
    seen.add(r.messageId);
    out.push({
      messageId: r.messageId,
      rank: out.length + 1,
      snippet: r.snippet.replace(/\s+/g, ' ').slice(0, 240),
      via: 'semantic',
    });
  }
  return out;
}

export async function search(
  db: DB,
  query: string,
  opts: SearchOptions = {},
): Promise<{ hits: SearchHit[]; usedSemantic: boolean; semanticSkippedReason?: string }> {
  const limit = opts.limit ?? 10;
  const mode = opts.mode ?? 'hybrid';

  const ranked: RankedRow[] = [];
  let usedSemantic = false;
  let semanticSkippedReason: string | undefined;

  if (mode !== 'semantic') {
    ranked.push(...ftsSearch(db, query, CANDIDATES));
  }
  if (mode !== 'fts') {
    if (!hasEmbeddings(db)) {
      semanticSkippedReason =
        'no embeddings in index — run `chatgrep index --embed` to enable semantic search';
      if (mode === 'semantic') {
        return { hits: [], usedSemantic: false, semanticSkippedReason };
      }
    } else {
      try {
        ranked.push(...(await semanticSearch(db, query, CANDIDATES)));
        usedSemantic = true;
      } catch (err) {
        semanticSkippedReason = `semantic search unavailable (${(err as Error).message})`;
        if (mode === 'semantic') {
          return { hits: [], usedSemantic: false, semanticSkippedReason };
        }
      }
    }
  }

  // Reciprocal Rank Fusion across the two rankings, keyed by message
  const fused = new Map<number, { score: number; snippets: Map<string, string>; via: Set<'fts' | 'semantic'> }>();
  for (const r of ranked) {
    let f = fused.get(r.messageId);
    if (!f) {
      f = { score: 0, snippets: new Map(), via: new Set() };
      fused.set(r.messageId, f);
    }
    f.score += 1 / (RRF_K + r.rank);
    if (!f.snippets.has(r.via)) f.snippets.set(r.via, r.snippet);
    f.via.add(r.via);
  }
  if (fused.size === 0) return { hits: [], usedSemantic, semanticSkippedReason };

  const ids = [...fused.keys()];
  const placeholders = ids.map(() => '?').join(',');
  const filters: string[] = [];
  const params: unknown[] = [...ids];
  if (opts.tool) {
    filters.push('s.tool = ?');
    params.push(opts.tool);
  }
  if (opts.project) {
    filters.push('s.project LIKE ?');
    params.push(`%${opts.project}%`);
  }
  if (opts.since) {
    filters.push("coalesce(m.ts, s.started_at, '') >= ?");
    params.push(opts.since);
  }
  const rows = db
    .prepare(
      `SELECT m.id AS messageId, m.role, m.ts, s.id AS sessionRowid, s.tool, s.session_id AS sessionId,
              s.source_path AS sourcePath, s.project, s.title
       FROM messages m JOIN sessions s ON s.id = m.session_rowid
       WHERE m.id IN (${placeholders}) ${filters.length ? 'AND ' + filters.join(' AND ') : ''}`,
    )
    .all(...params) as Omit<SearchHit, 'snippet' | 'score' | 'matchedBy'>[];

  const hits: SearchHit[] = rows.map((r) => {
    const f = fused.get(r.messageId)!;
    return {
      ...r,
      // FTS snippet has highlight markers — prefer it for display
      snippet: f.snippets.get('fts') ?? f.snippets.get('semantic') ?? '',
      score: f.score,
      matchedBy: [...f.via],
      extraHits: 0,
    };
  });
  hits.sort((a, b) => b.score - a.score);

  // one result per session: keep the best hit, count the rest
  const bySession = new Map<number, SearchHit>();
  for (const h of hits) {
    const kept = bySession.get(h.sessionRowid);
    if (!kept) bySession.set(h.sessionRowid, h);
    else kept.extraHits++;
  }
  const deduped = [...bySession.values()];
  return { hits: deduped.slice(0, limit), usedSemantic, semanticSkippedReason };
}
