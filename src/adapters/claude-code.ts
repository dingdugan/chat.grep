import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Adapter, SourceFile, UnifiedMessage, UnifiedSession } from '../types.js';

/** Claude Code stores sessions at ~/.claude/projects/<escaped-cwd>/<session-uuid>.jsonl,
 * one JSON object per line. Only `user` / `assistant` lines carry conversation content;
 * `ai-title` lines carry a generated session title. */

const SKIP_USER_PREFIXES = [
  '<command-name>',
  '<command-message>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  'Caveat: The messages below',
  '[Request interrupted',
];

/** harness error artifacts stored as assistant messages, not real conversation */
const SKIP_ASSISTANT_PREFIXES = ['API Error:', 'Request was aborted'];

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === 'object' && (b as any).type === 'text')
      .map((b) => (b as any).text ?? '')
      .join('\n');
  }
  return '';
}

function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object' && (b as any).type === 'text')
    .map((b) => (b as any).text ?? '')
    .join('\n');
}

function cleanUserText(text: string): string {
  // system-reminder blocks are harness-injected, not user content
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

export const claudeCodeAdapter: Adapter = {
  tool: 'claude-code',
  displayName: 'Claude Code',

  discover(): SourceFile[] {
    const root = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(root)) return [];
    const out: SourceFile[] = [];
    for (const dir of fs.readdirSync(root)) {
      const dirPath = path.join(root, dir);
      let entries: string[];
      try {
        if (!fs.statSync(dirPath).isDirectory()) continue;
        entries = fs.readdirSync(dirPath);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(dirPath, f);
        try {
          const st = fs.statSync(p);
          if (st.isFile()) out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          /* file vanished between readdir and stat */
        }
      }
    }
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
    let title: string | null = null;
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

      if (o.sessionId) sessionId = o.sessionId;
      if (o.cwd && !cwd) cwd = o.cwd;
      if (o.type === 'ai-title' && typeof o.aiTitle === 'string') title = o.aiTitle;
      if (o.type === 'summary' && typeof o.summary === 'string' && !title) title = o.summary;

      if (o.type !== 'user' && o.type !== 'assistant') continue;
      if (o.isMeta) continue;
      const ts = typeof o.timestamp === 'string' ? o.timestamp : null;
      if (ts) {
        if (!startedAt || ts < startedAt) startedAt = ts;
        if (!endedAt || ts > endedAt) endedAt = ts;
      }

      if (o.type === 'user') {
        let text = extractUserText(o.message?.content);
        if (!text) continue;
        if (SKIP_USER_PREFIXES.some((p) => text.startsWith(p))) continue;
        text = cleanUserText(text);
        if (!text) continue;
        messages.push({ role: 'user', text, timestamp: ts });
      } else {
        const text = extractAssistantText(o.message?.content).trim();
        if (!text) continue;
        if (SKIP_ASSISTANT_PREFIXES.some((p) => text.startsWith(p))) continue;
        messages.push({ role: 'assistant', text, timestamp: ts });
      }
    }

    if (messages.length === 0 && warnings === 0) return null;
    return {
      tool: this.tool,
      sessionId,
      sourcePath: filePath,
      cwd,
      title,
      startedAt,
      endedAt,
      messages,
      warnings,
    };
  },
};
