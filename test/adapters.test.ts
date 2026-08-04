import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { claudeCodeAdapter } from '../src/adapters/claude-code.js';
import { codexAdapter } from '../src/adapters/codex.js';
import { chunkText } from '../src/embeddings.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgrep-test-'));

function write(name: string, lines: string[]): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, lines.join('\n'));
  return p;
}

test('claude-code: parses user/assistant, skips corrupt lines with warning', () => {
  const p = write('cc-basic.jsonl', [
    JSON.stringify({
      type: 'user',
      sessionId: 's1',
      cwd: '/proj/foo',
      timestamp: '2026-01-01T00:00:00Z',
      message: { role: 'user', content: 'how do I fix CORS?' },
    }),
    '{ this is corrupt json',
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:01:00Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Use a proxy.' },
          { type: 'tool_use', name: 'Bash', input: {} },
        ],
      },
    }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Fix CORS issue', sessionId: 's1' }),
  ]);
  const s = claudeCodeAdapter.parse(p)!;
  assert.equal(s.sessionId, 's1');
  assert.equal(s.cwd, '/proj/foo');
  assert.equal(s.title, 'Fix CORS issue');
  assert.equal(s.warnings, 1);
  assert.deepEqual(
    s.messages.map((m) => [m.role, m.text]),
    [
      ['user', 'how do I fix CORS?'],
      ['assistant', 'Use a proxy.'],
    ],
  );
});

test('claude-code: strips system-reminder, skips command wrappers and meta', () => {
  const p = write('cc-noise.jsonl', [
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: 'real question<system-reminder>injected stuff</system-reminder>',
      },
    }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '<command-name>/clear</command-name>' },
    }),
    JSON.stringify({
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: 'meta noise' },
    }),
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'tool output' }],
      },
    }),
  ]);
  const s = claudeCodeAdapter.parse(p)!;
  assert.deepEqual(
    s.messages.map((m) => m.text),
    ['real question'],
  );
});

test('claude-code: empty file yields null', () => {
  const p = write('cc-empty.jsonl', ['']);
  assert.equal(claudeCodeAdapter.parse(p), null);
});

test('codex: parses session_meta + messages, filters injected/developer', () => {
  const p = write('codex-basic.jsonl', [
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-02-01T00:00:00Z',
      payload: { id: 'cx1', cwd: '/proj/bar', timestamp: '2026-02-01T00:00:00Z' },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-02-01T00:01:00Z',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>injected</environment_context>' }],
      },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-02-01T00:01:30Z',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md instructions for /proj' }],
      },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-02-01T00:02:00Z',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'why is the build red?' }],
      },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-02-01T00:03:00Z',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'dev channel noise' }],
      },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-02-01T00:04:00Z',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Missing env var.' }],
      },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-02-01T00:05:00Z',
      payload: { type: 'function_call', name: 'shell', arguments: '{}' },
    }),
    'corrupt line here',
  ]);
  const s = codexAdapter.parse(p)!;
  assert.equal(s.sessionId, 'cx1');
  assert.equal(s.cwd, '/proj/bar');
  assert.equal(s.warnings, 1);
  assert.deepEqual(
    s.messages.map((m) => [m.role, m.text]),
    [
      ['user', 'why is the build red?'],
      ['assistant', 'Missing env var.'],
    ],
  );
});

test('codex: file with only injected content yields null', () => {
  const p = write('codex-noise.jsonl', [
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<user_instructions>x</user_instructions>' }],
      },
    }),
  ]);
  assert.equal(codexAdapter.parse(p), null);
});

test('chunkText: short text is one chunk, huge text is capped', () => {
  assert.deepEqual(chunkText('hello'), ['hello']);
  const huge = 'x'.repeat(100_000);
  const chunks = chunkText(huge);
  assert.ok(chunks.length <= 8, `expected <=8 chunks, got ${chunks.length}`);
  assert.ok(chunks.every((c) => c.length <= 1200));
});
