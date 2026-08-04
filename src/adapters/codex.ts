import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Adapter, SourceFile, UnifiedMessage, UnifiedSession } from '../types.js';

/** Codex CLI/Desktop stores sessions at ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 * (plus ~/.codex/archived_sessions/). Lines: session_meta / response_item / event_msg / turn_context.
 * Conversation content lives in response_item.payload where payload.type === 'message'. */

const INJECTED_USER_PREFIXES = [
  '<environment_context>',
  '<permissions instructions>',
  '<app-context>',
  '<user_instructions>',
  '<AGENTS.md',
  '<turn-aborted',
  '<turn_aborted>',
  '<collaboration_mode',
  '<system>',
  '<skill>',
  '# AGENTS.md instructions',
];

function walkJsonl(dir: string, out: SourceFile[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try {
        const st = fs.statSync(p);
        out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* vanished */
      }
    }
  }
}

function blocksText(content: unknown, types: string[]): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object' && types.includes((b as any).type))
    .map((b) => (b as any).text ?? '')
    .join('\n');
}

export const codexAdapter: Adapter = {
  tool: 'codex',
  displayName: 'Codex',

  discover(): SourceFile[] {
    const out: SourceFile[] = [];
    walkJsonl(path.join(os.homedir(), '.codex', 'sessions'), out);
    walkJsonl(path.join(os.homedir(), '.codex', 'archived_sessions'), out);
    return out;
  },

  parse(filePath: string): UnifiedSession | null {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
    const messages: UnifiedMessage[] = [];
    let warnings = 0;
    let sessionId = path.basename(filePath, '.jsonl');
    let cwd: string | null = null;
    let startedAt: string | null = null;
    let endedAt: string | null = null;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        warnings++;
        continue;
      }
      if (!o || typeof o !== 'object') continue;

      if (o.type === 'session_meta' && o.payload) {
        if (o.payload.id) sessionId = o.payload.id;
        if (o.payload.cwd) cwd = o.payload.cwd;
        if (o.payload.timestamp) startedAt = o.payload.timestamp;
        continue;
      }
      if (o.type !== 'response_item' || !o.payload) continue;
      const p = o.payload;
      if (p.type !== 'message') continue;

      const ts = typeof o.timestamp === 'string' ? o.timestamp : null;
      if (ts) {
        if (!startedAt || ts < startedAt) startedAt = ts;
        if (!endedAt || ts > endedAt) endedAt = ts;
      }

      if (p.role === 'user') {
        const text = blocksText(p.content, ['input_text']).trim();
        if (!text) continue;
        if (INJECTED_USER_PREFIXES.some((pre) => text.startsWith(pre))) continue;
        messages.push({ role: 'user', text, timestamp: ts });
      } else if (p.role === 'assistant') {
        const text = blocksText(p.content, ['output_text']).trim();
        if (!text) continue;
        messages.push({ role: 'assistant', text, timestamp: ts });
      }
      // developer / system roles are injected context, not conversation
    }

    if (messages.length === 0 && warnings === 0) return null;
    return {
      tool: this.tool,
      sessionId,
      sourcePath: filePath,
      cwd,
      title: null,
      startedAt,
      endedAt,
      messages,
      warnings,
    };
  },
};
