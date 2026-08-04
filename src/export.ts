import type { DB } from './db.js';

export interface SessionRow {
  id: number;
  tool: string;
  session_id: string;
  source_path: string;
  cwd: string | null;
  project: string | null;
  title: string | null;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
}

/** Resolve by session-id prefix (as shown in search results) or sessions rowid. */
export function findSession(db: DB, ref: string): SessionRow | null {
  const byPrefix = db
    .prepare(`SELECT * FROM sessions WHERE session_id LIKE ? ORDER BY started_at DESC LIMIT 2`)
    .all(`${ref}%`) as SessionRow[];
  if (byPrefix.length >= 1) return byPrefix[0];
  if (/^\d+$/.test(ref)) {
    const byRowid = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(Number(ref)) as
      | SessionRow
      | undefined;
    if (byRowid) return byRowid;
  }
  return null;
}

export function exportMarkdown(db: DB, session: SessionRow): string {
  const messages = db
    .prepare(`SELECT role, ts, text FROM messages WHERE session_rowid = ? ORDER BY idx`)
    .all(session.id) as { role: string; ts: string | null; text: string }[];

  const lines: string[] = [];
  lines.push(`# ${session.title ?? `Session ${session.session_id.slice(0, 8)}`}`);
  lines.push('');
  lines.push(`- **Tool**: ${session.tool}`);
  lines.push(`- **Session**: ${session.session_id}`);
  if (session.cwd) lines.push(`- **Project**: ${session.cwd}`);
  if (session.started_at) lines.push(`- **Started**: ${session.started_at}`);
  if (session.ended_at) lines.push(`- **Ended**: ${session.ended_at}`);
  lines.push(`- **Messages**: ${session.message_count}`);
  lines.push(`- **Source**: ${session.source_path}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const m of messages) {
    const who = m.role === 'user' ? '🧑 User' : '🤖 Assistant';
    const when = m.ts ? ` · ${m.ts}` : '';
    lines.push(`## ${who}${when}`);
    lines.push('');
    lines.push(m.text);
    lines.push('');
  }
  return lines.join('\n');
}
