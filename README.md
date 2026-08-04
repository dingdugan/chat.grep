# chatgrep

**Search your AI coding sessions. Then distill them into CLAUDE.md.**

Your AI conversations are your second brain. Claude Code, Codex — every debugging session, every architecture decision, every hard-won fix is sitting in JSONL files on your disk. chatgrep does two things with them:

1. **Search** — full-text + semantic hybrid, in natural language, across all your tools: *"that time we fixed CORS"* / *「那次修跨域问题的方案」*
2. **Distill** — scan recent sessions for things you keep re-teaching your AI, and turn them into ready-to-paste CLAUDE.md entries. Search is pull; distill is the compounding loop.

## Privacy promise (read this first)

- **Indexing and full-text search never touch the network.** Everything is stored in a single SQLite file on your machine (`~/.chatgrep/index.db`).
- **Credentials are redacted at index time.** API keys, tokens, and private keys pasted into sessions (it happens more than you think) are replaced with `[REDACTED:<kind>]` markers before they ever hit the index. Distill's first real-world run flagged an actual API key pasted months earlier — that finding is why this feature exists.
- **Semantic search** uses a small local embedding model (multilingual-e5-small, ~110MB). It is downloaded **once** from HuggingFace, only after you explicitly opt in — after that, inference is 100% offline.
- **`distill` is the only feature that sends data to an LLM.** It shows you exactly what will be sent (how many sessions, how many characters, which backend) and asks for confirmation before every run.
- Nothing else leaves your machine. Ever.

## Quickstart

```bash
npm install -g chatgrep   # or: npx chatgrep

# 1. Index every session on this machine (Claude Code + Codex)
chatgrep index

# 2. Search — plain keywords…
chatgrep "sqlite busy timeout"

# …or enable semantic search and use natural language
chatgrep index --embed
chatgrep "that time we fixed the CORS issue"
```

Search results show the tool, project, date, a highlighted snippet, and the session id:

```
 1.  claude  my-webapp 2026-06-01 07:25 [assistant]
    …le:// protocol gets blocked by browser CORS. Start a local HTTP s…
    session 3f2a91c4 · ~/.claude/projects/-Users-me-my-webapp/3f2a91c4….jsonl
    → chatgrep export 3f2a91c4
```

## Commands

| Command | What it does |
|---|---|
| `chatgrep index` | Scan all tools' session files, incrementally index into SQLite (FTS5). Re-runs are fast — only changed files are re-ingested. |
| `chatgrep index --embed` | Also compute local embeddings for semantic search (asks once before downloading the model). |
| `chatgrep <query>` | Hybrid search: full-text (FTS5 trigram, works for CJK too) + semantic, fused with reciprocal-rank fusion. Flags: `--tool`, `--project`, `--since 30d`, `--fts`, `--semantic`, `-n`. |
| `chatgrep ui` | Local web GUI: search-as-you-type, filters, full session viewer. Binds to 127.0.0.1 only — nothing is exposed. |
| `chatgrep export <id>` | Export a session to clean markdown — your conversations, freed from proprietary formats. |
| `chatgrep distill [--since 30d]` | Scan recent sessions for **repeated patterns**: things you keep re-teaching your AI, recurring pitfalls, workflows worth turning into skills. Outputs ready-to-paste CLAUDE.md entries. Uses your `claude` CLI or `ANTHROPIC_API_KEY` — with explicit confirmation. |
| `chatgrep stats` | What's in the index. |

## Why distill?

If you've told your AI "use pnpm, not npm" fifteen times across three months, that's not a memory problem — it's a missing line in your CLAUDE.md. `chatgrep distill` finds those lines:

```bash
chatgrep distill --since 30d -o report.md
```

The report contains: repeated instructions (with ready-to-paste CLAUDE.md entries), recurring pitfalls (with suggested guards), workflows worth turning into skills, and one-off knowledge worth persisting — each with evidence citations back to your sessions. It runs through your existing `claude` CLI subscription or an `ANTHROPIC_API_KEY`, after an explicit confirmation showing exactly what leaves your machine.

## Platform support

Developed and tested on **macOS (Apple Silicon) + Node ≥ 20**. Linux should work (better-sqlite3 / sqlite-vec ship prebuilds) but is untested; Windows is untested. The `claude` CLI auto-discovery fallbacks are macOS-specific — on other platforms, have `claude` on PATH or set `ANTHROPIC_API_KEY` for distill. Reports and PRs welcome.

## Supported tools

| Tool | Session location | Status |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | ✅ |
| Codex (CLI + Desktop) | `~/.codex/sessions/`, `~/.codex/archived_sessions/` | ✅ |
| Cursor | `state.vscdb` (SQLite) | PRs welcome 👇 |

## Add your tool (contributing)

Adapters are deliberately the thinnest layer in the codebase. To add a tool:

1. Create `src/adapters/<your-tool>.ts` implementing the `Adapter` interface ([src/types.ts](src/types.ts)) — two functions: `discover()` (list session files) and `parse(path)` (return a `UnifiedSession`).
2. Register it in [src/adapters/index.ts](src/adapters/index.ts).

Everything else — indexing, FTS, embeddings, hybrid search, distill, export — works on the unified format and comes for free. A parser that breaks on a format change only breaks ingestion for that one tool.

## How it works

```
~/.claude/projects/**.jsonl ─┐
                             ├─ adapters ─→ unified format ─→ SQLite (FTS5 + sqlite-vec)
~/.codex/sessions/**.jsonl ──┘                                      │
                                              hybrid search ←───────┤
                                              (RRF fusion)          │
                                              distill ←─────────────┘
```

- **Storage**: one SQLite database — FTS5 with trigram tokenizer (substring + CJK-friendly matching) and sqlite-vec for vectors.
- **Embeddings**: multilingual-e5-small (quantized) via transformers.js (ONNX, local CPU inference).
- **Incremental**: files are fingerprinted by mtime+size; unchanged files are skipped.

## Development

```bash
npm install
npm run build      # tsc
npm test           # adapter + edge-case tests
npm run dev -- stats
```

## License

MIT
