import os from 'node:os';
import pc from 'picocolors';
import type { SearchHit } from './search.js';

export function tildify(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function toolBadge(tool: string): string {
  if (tool === 'claude-code') return pc.bgMagenta(pc.white(' claude '));
  if (tool === 'codex') return pc.bgCyan(pc.black(' codex '));
  return pc.bgWhite(pc.black(` ${tool} `));
}

function fmtDate(ts: string | null): string {
  if (!ts) return 'unknown date';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return 'unknown date';
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

/** \x01 / \x02 are the FTS snippet() highlight markers */
function highlight(snippet: string): string {
  const cleaned = snippet.replace(/\s+/g, ' ').trim();
  if (!cleaned.includes('\x01')) return cleaned;
  return cleaned.replace(/\x01([\s\S]*?)\x02/g, (_, m) => pc.bold(pc.yellow(m)));
}

export function renderHits(hits: SearchHit[], query: string): string {
  if (hits.length === 0) {
    return pc.dim(`no matches for "${query}"`);
  }
  const lines: string[] = [];
  hits.forEach((h, i) => {
    const head = [
      pc.dim(`${String(i + 1).padStart(2)}.`),
      toolBadge(h.tool),
      pc.bold(h.project ?? '(no project)'),
      pc.dim(fmtDate(h.ts)),
      pc.dim(`[${h.role}]`),
      h.matchedBy.includes('semantic') && !h.matchedBy.includes('fts')
        ? pc.green('~semantic')
        : '',
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(head);
    if (h.title) lines.push('    ' + pc.italic(h.title));
    lines.push(
      '    ' +
        highlight(h.snippet) +
        (h.extraHits > 0 ? pc.dim(`  (+${h.extraHits} more in this session)`) : ''),
    );
    lines.push(
      '    ' + pc.dim(`session ${h.sessionId.slice(0, 8)} · ${tildify(h.sourcePath)}`),
    );
    lines.push('    ' + pc.dim(`→ chatgrep export ${h.sessionId.slice(0, 8)}`));
    lines.push('');
  });
  return lines.join('\n');
}

export { fmtDate, toolBadge, highlight };
