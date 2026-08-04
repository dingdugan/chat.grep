import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import type { DB } from './db.js';

/** distill = scan recent sessions for repeated patterns worth persisting into
 * CLAUDE.md / skills. This is the ONLY chatgrep feature that sends data to an
 * LLM, so it never runs without an explicit confirmation (see cli.ts). */

const MAX_TOTAL_CHARS = 60_000;
const MAX_PER_MESSAGE = 600;
const MAX_USER_MSGS_PER_SESSION = 12;

export interface DistillCorpus {
  sessionCount: number;
  chars: number;
  text: string;
  sinceIso: string;
}

export function parseSince(since: string): string {
  const m = /^(\d+)([dwm])$/.exec(since);
  if (!m) throw new Error(`invalid --since value "${since}" (use e.g. 30d, 4w, 2m)`);
  const n = Number(m[1]);
  const days = m[2] === 'd' ? n : m[2] === 'w' ? n * 7 : n * 30;
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString();
}

export function buildCorpus(db: DB, sinceIso: string): DistillCorpus {
  const sessions = db
    .prepare(
      `SELECT id, tool, project, title, started_at FROM sessions
       WHERE coalesce(started_at, '') >= ? ORDER BY started_at DESC`,
    )
    .all(sinceIso) as {
    id: number;
    tool: string;
    project: string | null;
    title: string | null;
    started_at: string | null;
  }[];

  const getUserMsgs = db.prepare(
    `SELECT text FROM messages WHERE session_rowid = ? AND role = 'user' ORDER BY idx LIMIT ?`,
  );

  const parts: string[] = [];
  let chars = 0;
  let included = 0;
  for (const s of sessions) {
    const msgs = getUserMsgs.all(s.id, MAX_USER_MSGS_PER_SESSION) as { text: string }[];
    if (msgs.length === 0) continue;
    const header = `### Session [${s.tool}] project=${s.project ?? '?'} date=${s.started_at?.slice(0, 10) ?? '?'}${s.title ? ` title=${s.title}` : ''}`;
    const body = msgs
      .map((m) => '- ' + m.text.replace(/\s+/g, ' ').slice(0, MAX_PER_MESSAGE))
      .join('\n');
    const block = `${header}\n${body}\n`;
    if (chars + block.length > MAX_TOTAL_CHARS) break;
    parts.push(block);
    chars += block.length;
    included++;
  }
  return { sessionCount: included, chars, text: parts.join('\n'), sinceIso };
}

export function buildPrompt(corpus: DistillCorpus): string {
  return `You are analyzing excerpts from a developer's AI coding sessions (user messages only, grouped by session). Your job is to find REPEATED patterns — things the user keeps teaching or re-explaining to their AI tools — and turn them into durable configuration.

Produce a markdown report with exactly these sections:

## 1. Repeated instructions → CLAUDE.md candidates
Things the user has told the AI more than once across sessions (preferences, conventions, constraints). For each: the pattern, evidence (which sessions/projects), and a ready-to-paste CLAUDE.md entry in a code block.

## 2. Repeated pitfalls
Bugs, mistakes or misunderstandings that recur. For each: what happens, and a suggested guard (rule, check, or doc).

## 3. Skill / automation candidates
Multi-step workflows the user asks for repeatedly that could become a reusable skill, script, or slash command.

## 4. One-off but valuable
Knowledge that appeared once but is clearly worth persisting (hard-won configs, gotchas).

Rules:
- Only report patterns with real evidence in the excerpts. If a section has nothing, say "Nothing found."
- Quote short fragments as evidence, cite the session header (tool/project/date).
- Write the report in the language the user predominantly writes in.
- Ready-to-paste entries must be concise and imperative.

--- SESSION EXCERPTS (since ${corpus.sinceIso.slice(0, 10)}, ${corpus.sessionCount} sessions) ---

${corpus.text}`;
}

export type DistillBackend =
  | { kind: 'claude-cli'; claudePath: string }
  | { kind: 'api' };

/** Locate a runnable claude binary: PATH, then the env var Claude Code sets for
 * its own subprocesses, then the desktop app's install directory. */
export function resolveClaudeBin(): string | null {
  const which = spawnSync('which', ['claude'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();

  const candidates: string[] = [];
  if (process.env.CLAUDE_CODE_EXECPATH) candidates.push(process.env.CLAUDE_CODE_EXECPATH);
  const appDir = `${process.env.HOME}/Library/Application Support/Claude/claude-code`;
  try {
    const versions = fs.readdirSync(appDir).sort().reverse();
    for (const v of versions) {
      candidates.push(`${appDir}/${v}/claude.app/Contents/MacOS/claude`);
    }
  } catch {
    /* not installed via desktop app */
  }
  for (const c of candidates) {
    const probe = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    if (probe.status === 0) return c;
  }
  return null;
}

export function detectBackend(preferred?: string): DistillBackend {
  if (preferred === 'api') {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('backend "api" needs ANTHROPIC_API_KEY set');
    }
    return { kind: 'api' };
  }
  if (preferred === 'claude-cli' || preferred === undefined) {
    const bin = resolveClaudeBin();
    if (bin) return { kind: 'claude-cli', claudePath: bin };
    if (preferred === 'claude-cli') throw new Error('claude CLI not found');
    if (process.env.ANTHROPIC_API_KEY) return { kind: 'api' };
    throw new Error(
      'no LLM backend available: install the claude CLI or set ANTHROPIC_API_KEY',
    );
  }
  throw new Error(`unknown backend "${preferred}" (use claude-cli or api)`);
}

/** transient failures worth retrying: dropped connections, overload, rate limits */
const TRANSIENT_RE = /connection closed|connection error|overloaded|rate limit|529|timed? ?out|ECONNRESET|ETIMEDOUT/i;
const MAX_ATTEMPTS = 3;

export async function runDistill(
  prompt: string,
  backend: DistillBackend,
  model?: string,
  onRetry?: (attempt: number, err: string) => void,
): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await runDistillOnce(prompt, backend, model);
    } catch (err) {
      lastErr = err as Error;
      if (attempt < MAX_ATTEMPTS && TRANSIENT_RE.test(lastErr.message)) {
        onRetry?.(attempt, lastErr.message);
        await new Promise((r) => setTimeout(r, attempt * 5000));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr!;
}

async function runDistillOnce(
  prompt: string,
  backend: DistillBackend,
  model?: string,
): Promise<string> {
  if (backend.kind === 'claude-cli') {
    const args = ['-p', '--output-format', 'text'];
    if (model) args.push('--model', model);
    // async spawn: distill can take minutes and must not block the ui server
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(backend.claudePath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill(), 600_000);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const all = `${out}\n${err}`;
        if (all.includes('Not logged in')) {
          reject(
            new Error(
              'claude CLI 未登录。在终端跑一次：npm install -g @anthropic-ai/claude-code && claude（进入后输入 /login 完成授权），或设置 ANTHROPIC_API_KEY 后重启 chatgrep ui',
            ),
          );
        } else if (code !== 0) {
          reject(new Error(`claude CLI failed (exit ${code}): ${(err || out).slice(0, 500)}`));
        } else if (!out.trim()) {
          reject(new Error(`claude CLI returned empty output: ${err.slice(0, 500)}`));
        } else {
          resolve(out.trim());
        }
      });
      child.stdin.end(prompt);
    });
  }
  // Anthropic Messages API
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: model ?? 'claude-sonnet-5',
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!resp.ok) {
    throw new Error(`Anthropic API error ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  }
  const data = (await resp.json()) as { content: { type: string; text?: string }[] };
  return data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
