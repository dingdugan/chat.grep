#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
import { Command } from 'commander';
import pc from 'picocolors';
import { openDb } from './db.js';
import { indexAll } from './indexer.js';
import { search } from './search.js';
import { renderHits, fmtDate, toolBadge } from './render.js';
import { findSession, exportMarkdown } from './export.js';
import { embedMissing, modelIsCached } from './embeddings.js';
import { buildCorpus, buildPrompt, detectBackend, parseSince, runDistill } from './distill.js';
import { EMBEDDING_MODEL, dbPath } from './config.js';

const program = new Command();

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

program
  .name('chatgrep')
  .description(
    'Search all your AI coding sessions (Claude Code, Codex) — full-text + semantic, fully local.',
  )
  .version('0.1.0');

program
  .command('index')
  .description('scan session files from all tools and (incrementally) index them')
  .option('--tool <tool>', 'only index one tool (claude-code | codex)')
  .option('--embed', 'also compute local embeddings for semantic search')
  .option('--force', 'reindex all files even if unchanged (after chatgrep upgrades)')
  .option('-y, --yes', 'skip confirmation for first-time model download')
  .action(async (opts: { tool?: string; embed?: boolean; force?: boolean; yes?: boolean }) => {
    const db = openDb();
    const t0 = Date.now();
    const stats = indexAll(db, {
      tools: opts.tool ? [opts.tool] : undefined,
      force: opts.force,
      onProgress: (m) => console.error(pc.dim(m)),
    });
    for (const s of stats) {
      console.log(
        `${toolBadge(s.tool)} scanned ${s.scanned} files: ${pc.green(`${s.ingested} ingested`)}, ${s.skipped} unchanged` +
          (s.warnings ? pc.yellow(`, ${s.warnings} warnings`) : '') +
          pc.dim(` (${s.sessions} sessions, ${s.messages} messages)`),
      );
    }
    console.log(pc.dim(`index: ${dbPath()} · ${((Date.now() - t0) / 1000).toFixed(1)}s`));

    if (opts.embed) {
      if (!modelIsCached()) {
        console.error(
          `\nSemantic search needs the local embedding model ${pc.bold(EMBEDDING_MODEL)} (~110MB).\n` +
            `It will be downloaded ONCE from huggingface.co, then everything runs offline.\n` +
            pc.bold('This is the only network access chatgrep ever does without an LLM backend.'),
        );
        const ok = opts.yes || (await confirm('Download the model now?'));
        if (!ok) {
          console.error(pc.yellow('skipped embeddings (re-run with --embed -y to allow the download)'));
          return;
        }
      }
      const t1 = Date.now();
      let lastPct = -1;
      const added = await embedMissing(db, (done, total) => {
        const pct = Math.floor((done / total) * 100);
        if (pct !== lastPct && pct % 5 === 0) {
          process.stderr.write(`\rembedding chunks: ${done}/${total} (${pct}%)`);
          lastPct = pct;
        }
      });
      if (added > 0) process.stderr.write('\n');
      console.log(
        `${pc.green(`${added} chunks embedded`)} ${pc.dim(`(${((Date.now() - t1) / 1000).toFixed(1)}s)`)}`,
      );
    }
  });

program
  .command('search <query...>', { isDefault: true })
  .description('search indexed sessions (hybrid full-text + semantic when embeddings exist)')
  .option('-n, --limit <n>', 'max results', '10')
  .option('--tool <tool>', 'filter by tool (claude-code | codex)')
  .option('--project <name>', 'filter by project name (substring)')
  .option('--since <dur>', 'only messages newer than e.g. 30d / 4w / 2m')
  .option('--fts', 'full-text only')
  .option('--semantic', 'semantic only')
  .action(
    async (
      queryParts: string[],
      opts: {
        limit: string;
        tool?: string;
        project?: string;
        since?: string;
        fts?: boolean;
        semantic?: boolean;
      },
    ) => {
      const query = queryParts.join(' ');
      const db = openDb();
      const sessionCount = (db.prepare(`SELECT count(*) n FROM sessions`).get() as { n: number }).n;
      if (sessionCount === 0) {
        console.error(pc.yellow('index is empty — run `chatgrep index` first'));
        process.exitCode = 1;
        return;
      }
      const mode = opts.fts ? 'fts' : opts.semantic ? 'semantic' : 'hybrid';
      const { hits, usedSemantic, semanticSkippedReason } = await search(db, query, {
        limit: Number(opts.limit),
        tool: opts.tool,
        project: opts.project,
        since: opts.since ? parseSince(opts.since) : undefined,
        mode,
      });
      console.log(renderHits(hits, query));
      if (semanticSkippedReason && mode !== 'fts') {
        console.error(pc.dim(`note: ${semanticSkippedReason}`));
      } else if (usedSemantic) {
        console.error(pc.dim('mode: hybrid (fts + semantic)'));
      }
    },
  );

program
  .command('export <session>')
  .description('export a session to markdown (session id prefix, as shown in search results)')
  .option('-o, --out <file>', 'write to file instead of stdout')
  .action((ref: string, opts: { out?: string }) => {
    const db = openDb();
    const session = findSession(db, ref);
    if (!session) {
      console.error(pc.red(`no session matching "${ref}" — use the id shown in search results`));
      process.exitCode = 1;
      return;
    }
    const md = exportMarkdown(db, session);
    if (opts.out) {
      fs.writeFileSync(opts.out, md);
      console.error(pc.green(`exported ${session.session_id.slice(0, 8)} → ${opts.out}`));
    } else {
      console.log(md);
    }
  });

program
  .command('distill')
  .description(
    'scan recent sessions for repeated patterns worth persisting into CLAUDE.md / skills (uses an LLM — asks before sending anything)',
  )
  .option('--since <dur>', 'look-back window, e.g. 30d / 4w / 2m', '30d')
  .option('--backend <b>', 'claude-cli | api (default: auto-detect)')
  .option('--model <model>', 'model override for the backend')
  .option('-o, --out <file>', 'write report to file instead of stdout')
  .option('-y, --yes', 'skip the data-egress confirmation')
  .action(
    async (opts: { since: string; backend?: string; model?: string; out?: string; yes?: boolean }) => {
      const db = openDb();
      const sinceIso = parseSince(opts.since);
      const corpus = buildCorpus(db, sinceIso);
      if (corpus.sessionCount === 0) {
        console.error(pc.yellow(`no indexed sessions since ${sinceIso.slice(0, 10)} — run \`chatgrep index\` first`));
        process.exitCode = 1;
        return;
      }
      const backend = detectBackend(opts.backend);
      console.error(
        `${pc.bold('distill will send data to an LLM:')}\n` +
          `  sessions: ${corpus.sessionCount} (since ${sinceIso.slice(0, 10)})\n` +
          `  payload:  ~${Math.round(corpus.chars / 1000)}k chars of YOUR user messages (truncated excerpts)\n` +
          `  backend:  ${backend.kind === 'claude-cli' ? `claude CLI (${backend.claudePath})` : 'Anthropic API (ANTHROPIC_API_KEY)'}\n`,
      );
      if (!opts.yes) {
        const ok = await confirm('Proceed?');
        if (!ok) {
          console.error(pc.yellow('aborted — nothing was sent (use --yes to skip this prompt)'));
          process.exitCode = 1;
          return;
        }
      }
      console.error(pc.dim('running distill… (this can take a minute)'));
      const report = await runDistill(buildPrompt(corpus), backend, opts.model, (n, e) =>
        console.error(pc.yellow(`transient error (attempt ${n}), retrying: ${e.slice(0, 120)}`)),
      );
      if (opts.out) {
        fs.writeFileSync(opts.out, report);
        console.error(pc.green(`report → ${opts.out}`));
      } else {
        console.log(report);
      }
    },
  );

program
  .command('ui')
  .description('open the local web UI (binds to 127.0.0.1 only — nothing is exposed)')
  .option('-p, --port <port>', 'port to listen on', '8321')
  .option('--no-open', 'do not auto-open the browser')
  .action(async (opts: { port: string; open: boolean }) => {
    const { startServer } = await import('./server.js');
    const db = openDb();
    startServer(db, { port: Number(opts.port), open: opts.open });
  });

program
  .command('stats')
  .description('show what is in the index')
  .action(() => {
    const db = openDb();
    const rows = db
      .prepare(
        `SELECT tool, count(*) sessions, sum(message_count) messages,
                min(started_at) first, max(ended_at) last
         FROM sessions GROUP BY tool`,
      )
      .all() as { tool: string; sessions: number; messages: number; first: string; last: string }[];
    if (rows.length === 0) {
      console.log(pc.yellow('index is empty — run `chatgrep index`'));
      return;
    }
    for (const r of rows) {
      console.log(
        `${toolBadge(r.tool)} ${r.sessions} sessions · ${r.messages} messages · ${fmtDate(r.first)} → ${fmtDate(r.last)}`,
      );
    }
    const chunks = (db.prepare(`SELECT count(*) n FROM chunks`).get() as { n: number }).n;
    console.log(
      chunks > 0
        ? pc.dim(`semantic: ${chunks} embedded chunks`)
        : pc.dim('semantic: not enabled (run `chatgrep index --embed`)'),
    );
    console.log(pc.dim(`db: ${dbPath()}`));
  });

program.parseAsync().catch((err) => {
  console.error(pc.red(String(err?.message ?? err)));
  process.exit(1);
});
