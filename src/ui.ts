/** Single-file GUI. No external resources — works fully offline. */
export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>chatgrep</title>
<style>
  :root {
    --bg: #f6f7f9; --panel: #ffffff; --text: #1a1d21; --dim: #6b7280;
    --border: #e2e5ea; --accent: #6d28d9; --accent-soft: #ede9fe;
    --mark: #fde68a; --claude: #d97706; --codex: #0891b2; --user: #6d28d9;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115; --panel: #171a21; --text: #e5e7eb; --dim: #8b93a1;
      --border: #262b36; --accent: #a78bfa; --accent-soft: #2e1065;
      --mark: #92670a; --claude: #f59e0b; --codex: #22d3ee; --user: #a78bfa;
    }
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    background: var(--bg); color: var(--text);
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    height: 100vh; display: flex; flex-direction: column;
  }
  header {
    display: flex; align-items: center; gap: 12px; padding: 10px 16px;
    border-bottom: 1px solid var(--border); background: var(--panel); flex-wrap: wrap;
  }
  header h1 { font-size: 16px; font-weight: 700; letter-spacing: -0.02em; }
  header h1 span { color: var(--accent); }
  #stats { color: var(--dim); font-size: 12px; }
  #reindex {
    margin-left: auto; border: 1px solid var(--border); background: transparent;
    color: var(--dim); border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer;
  }
  #reindex:hover { color: var(--text); border-color: var(--dim); }
  .searchbar {
    display: flex; gap: 8px; padding: 12px 16px; background: var(--panel);
    border-bottom: 1px solid var(--border); flex-wrap: wrap;
  }
  #q {
    flex: 1; min-width: 240px; padding: 9px 12px; font-size: 15px;
    border: 1.5px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text);
    outline: none;
  }
  #q:focus { border-color: var(--accent); }
  select {
    border: 1px solid var(--border); background: var(--bg); color: var(--text);
    border-radius: 8px; padding: 0 8px; font-size: 13px;
  }
  main { flex: 1; display: flex; min-height: 0; }
  #results { width: 46%; min-width: 320px; overflow-y: auto; border-right: 1px solid var(--border); }
  #viewer { flex: 1; overflow-y: auto; background: var(--panel); }
  .hit { padding: 12px 16px; border-bottom: 1px solid var(--border); cursor: pointer; }
  .hit:hover, .hit.active { background: var(--panel); }
  .hit.active { box-shadow: inset 3px 0 0 var(--accent); }
  .meta { display: flex; gap: 8px; align-items: baseline; font-size: 12px; color: var(--dim); flex-wrap: wrap; }
  .badge { font-size: 10.5px; font-weight: 700; padding: 1px 7px; border-radius: 99px; color: #fff; letter-spacing: 0.02em; }
  .badge.claude-code { background: var(--claude); }
  .badge.codex { background: var(--codex); }
  .proj { font-weight: 600; color: var(--text); }
  .title { font-size: 12.5px; color: var(--dim); font-style: italic; margin-top: 2px;
           overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .snip { margin-top: 4px; font-size: 13px; overflow-wrap: anywhere; }
  .snip mark { background: var(--mark); color: inherit; border-radius: 2px; padding: 0 1px; }
  .extra { color: var(--dim); font-size: 11.5px; }
  .empty { padding: 40px 20px; text-align: center; color: var(--dim); }
  .note { padding: 8px 16px; font-size: 12px; color: var(--dim); border-bottom: 1px solid var(--border); }
  .sechead { padding: 10px 16px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--dim); }
  /* viewer */
  .vhead { padding: 14px 20px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--panel); }
  .vhead h2 { font-size: 15px; margin-bottom: 4px; }
  .vhead .meta { font-size: 12px; }
  .vhead .path { font-family: ui-monospace, monospace; font-size: 11px; color: var(--dim); overflow-wrap: anywhere; margin-top: 4px; }
  .msg { padding: 14px 20px; border-bottom: 1px solid var(--border); }
  .msg .who { font-size: 11.5px; font-weight: 700; margin-bottom: 6px; }
  .msg.user .who { color: var(--user); }
  .msg.assistant .who { color: var(--dim); }
  .msg.flash { animation: flash 1.6s ease-out; }
  @keyframes flash { 0% { background: var(--accent-soft); } 100% { background: transparent; } }
  .msg pre {
    white-space: pre-wrap; overflow-wrap: anywhere;
    font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .msg pre code, .msg .cb { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .msg .cb { display: block; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; margin: 6px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .spinner { color: var(--dim); padding: 12px 16px; font-size: 13px; }
  /* help / welcome card */
  .help { max-width: 640px; margin: 0 auto; padding: 36px 28px; }
  .help h2 { font-size: 20px; letter-spacing: -0.02em; margin-bottom: 6px; }
  .help > p { color: var(--dim); margin-bottom: 22px; }
  .help h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--dim); margin: 22px 0 10px; }
  .exs { display: flex; flex-wrap: wrap; gap: 8px; }
  .ex {
    border: 1px solid var(--border); background: var(--bg); color: var(--text);
    border-radius: 99px; padding: 6px 14px; font-size: 13px; cursor: pointer;
  }
  .ex:hover { border-color: var(--accent); color: var(--accent); }
  .help table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .help td { padding: 7px 10px 7px 0; border-bottom: 1px solid var(--border); vertical-align: top; }
  .help td:first-child { white-space: nowrap; font-weight: 600; }
  .help code, .help kbd {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px;
  }
  #helpbtn, #distillbtn {
    border: 1px solid var(--border); background: transparent; color: var(--dim);
    border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer;
  }
  #helpbtn:hover, #distillbtn:hover { color: var(--text); border-color: var(--dim); }
  #distillbtn { color: var(--accent); border-color: var(--accent); opacity: 0.85; }
  /* distill panel */
  .dst label { font-size: 13px; margin-right: 8px; }
  .dst .row { display: flex; align-items: center; gap: 10px; margin: 14px 0; flex-wrap: wrap; }
  .dst .preview {
    background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
    padding: 12px 14px; font-size: 13px; line-height: 1.7;
  }
  .dst .warn { color: var(--claude); font-weight: 600; }
  .dst .err { color: #dc2626; }
  .dst button.primary {
    background: var(--accent); color: #fff; border: none; border-radius: 8px;
    padding: 8px 18px; font-size: 13.5px; font-weight: 600; cursor: pointer;
  }
  .dst button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .report { max-width: 760px; margin: 0 auto; padding: 24px 28px; }
  .report pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 13.5px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .report .actions { margin: 0 0 14px; display: flex; gap: 8px; }
</style>
</head>
<body>
<header>
  <h1>chat<span>grep</span></h1>
  <div id="stats">loading…</div>
  <button id="helpbtn" title="what can chatgrep do?">? Help</button>
  <button id="distillbtn" title="find repeated patterns worth persisting into CLAUDE.md">✦ Distill</button>
  <button id="reindex" title="incrementally re-scan session files">↻ Reindex</button>
</header>
<div class="searchbar">
  <input id="q" placeholder='search all your AI sessions — try "那次修跨域问题的方案"' autofocus>
  <select id="mode">
    <option value="hybrid">hybrid</option>
    <option value="fts">keyword</option>
    <option value="semantic">semantic</option>
  </select>
  <select id="tool">
    <option value="">all tools</option>
    <option value="claude-code">claude-code</option>
    <option value="codex">codex</option>
  </select>
</div>
<main>
  <div id="results"><div class="empty">…</div></div>
  <div id="viewer"></div>
</main>
<script>
const $ = (id) => document.getElementById(id);

const HELP_HTML = \`
<div class="help">
  <h2>Your AI conversations are your second brain. This is its grep.</h2>
  <p>Every Claude Code / Codex session on this machine is indexed locally.
     Ask in natural language — chatgrep finds the conversation where you already solved it.</p>

  <h3>Try one (click to search)</h3>
  <div class="exs">
    <button class="ex">那次修跨域问题的方案</button>
    <button class="ex">App Store 上架被拒怎么处理的</button>
    <button class="ex">sqlite busy timeout</button>
    <button class="ex">部署到 vercel 的配置</button>
    <button class="ex">那个反复出现的报错最后怎么解决的</button>
  </div>

  <h3>What people use it for</h3>
  <table>
    <tr><td>找回方案</td><td>"三周前明明解决过" — 用自然语言把它捞回来，不用记关键词</td></tr>
    <tr><td>跨工具查找</td><td>Claude Code 和 Codex 的会话在同一个搜索框里，不用挨个翻</td></tr>
    <tr><td>读完整上下文</td><td>点任何结果，右侧读整段会话，自动跳到命中的那条消息</td></tr>
    <tr><td>持久化</td><td><code>chatgrep export &lt;id&gt;</code> 把会话导出成 markdown，摆脱专有格式</td></tr>
    <tr><td>沉淀经验</td><td>右上角 <b>✦ Distill</b>：找出你反复在教 AI 的同一件事，生成可直接粘进 CLAUDE.md 的条目（CLI: <code>chatgrep distill</code>）</td></tr>
  </table>

  <h3>Search modes</h3>
  <table>
    <tr><td>hybrid</td><td>默认。关键词 + 语义融合，两边的命中都要</td></tr>
    <tr><td>keyword</td><td>精确子串匹配（函数名、报错原文、ID 这类查询用它）</td></tr>
    <tr><td>semantic</td><td>纯语义。描述大意就行，中文查英文内容也可以</td></tr>
  </table>

  <h3>Keep it fresh</h3>
  <table>
    <tr><td>↻ Reindex</td><td>右上角按钮：增量扫描新会话（也可以终端跑 <code>chatgrep index --embed</code>）</td></tr>
    <tr><td>Privacy</td><td>索引与搜索 100% 本地，服务只绑 127.0.0.1。唯一联网的功能是 distill，发送前必须你确认</td></tr>
  </table>
</div>\`;

function showHelp() {
  document.querySelectorAll('.hit').forEach(el => el.classList.remove('active'));
  $('viewer').innerHTML = HELP_HTML;
  $('viewer').scrollTop = 0;
}

async function showDistill() {
  document.querySelectorAll('.hit').forEach(el => el.classList.remove('active'));
  $('viewer').innerHTML = \`
  <div class="help dst">
    <h2>✦ Distill</h2>
    <p>扫描近期会话，找出你<b>反复在教 AI 的同一件事</b>、反复踩的坑、值得做成 skill 的工作流，
       生成可直接粘进 CLAUDE.md 的条目。这是 chatgrep 唯一会把数据发给 LLM 的功能 —— 发送前你会在下面看到确切的数据范围。</p>
    <div class="row">
      <label>时间窗:</label>
      <select id="dst-since">
        <option value="7d">最近 7 天</option>
        <option value="30d" selected>最近 30 天</option>
        <option value="90d">最近 90 天</option>
      </select>
    </div>
    <div class="preview" id="dst-preview">loading preview…</div>
    <div class="row">
      <button class="primary" id="dst-run" disabled>确认发送并生成报告</button>
      <span id="dst-status" style="color:var(--dim);font-size:13px"></span>
    </div>
  </div>\`;
  $('viewer').scrollTop = 0;
  $('dst-since').addEventListener('change', loadDistillPreview);
  $('dst-run').addEventListener('click', runDistillUi);
  loadDistillPreview();
}

async function loadDistillPreview() {
  const since = $('dst-since').value;
  $('dst-preview').textContent = 'loading preview…';
  $('dst-run').disabled = true;
  const r = await fetch('/api/distill/preview?since=' + since).then(r => r.json());
  let html = '将发送: <b>' + r.sessionCount + '</b> 个会话中你的 user 消息节选，约 <b>'
    + Math.round(r.chars / 1000) + 'k</b> 字符（自 ' + r.sinceIso.slice(0, 10) + ' 起）<br>';
  if (r.backend) {
    html += '后端: <b>' + (r.backend.kind === 'claude-cli' ? 'claude CLI（你已有的订阅）' : 'Anthropic API') + '</b><br>'
      + '<span class="warn">⚠ 点击下方按钮后，上述数据将离开本机发送给 LLM。仅此功能联网。</span>';
    if (r.sessionCount > 0) $('dst-run').disabled = false;
  } else {
    html += '<span class="err">✗ 没有可用的 LLM 后端: ' + esc(r.backendError ?? '')
      + '</span><br>在终端跑一次 <code>claude /login</code>，或设置 ANTHROPIC_API_KEY，然后回来刷新。';
  }
  if (r.sessionCount === 0) html += '<br><span class="err">该时间窗内没有已索引的会话。</span>';
  $('dst-preview').innerHTML = html;
}

async function runDistillUi() {
  const since = $('dst-since').value;
  $('dst-run').disabled = true;
  $('dst-status').textContent = '生成中… 通常需要 1-3 分钟，别关这个页面';
  try {
    const resp = await fetch('/api/distill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ since }),
    });
    const r = await resp.json();
    if (r.error) throw new Error(r.error);
    $('viewer').innerHTML = '<div class="report">'
      + '<div class="actions"><button class="ex" id="dst-copy">📋 复制报告</button>'
      + '<button class="ex" id="dst-back">← 重新生成</button></div>'
      + '<pre>' + renderText(r.report) + '</pre></div>';
    $('viewer').scrollTop = 0;
    const raw = r.report;
    $('dst-copy').addEventListener('click', () => {
      navigator.clipboard.writeText(raw);
      $('dst-copy').textContent = '✓ 已复制';
    });
    $('dst-back').addEventListener('click', showDistill);
  } catch (e) {
    $('dst-status').innerHTML = '<span class="err">失败: ' + esc(e.message) + '</span>';
    $('dst-run').disabled = false;
  }
}
const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fmtDate = (ts) => ts ? new Date(ts).toISOString().slice(0,16).replace('T',' ') : '';

async function loadStats() {
  const r = await fetch('/api/stats').then(r => r.json());
  $('stats').textContent = r.tools.map(t => t.tool + ': ' + t.sessions + ' sessions').join(' · ')
    + (r.chunks ? ' · semantic ✓' : ' · semantic off');
}

function hitHtml(h, i) {
  return '<div class="hit" data-ref="' + h.sessionId + '" data-mid="' + (h.messageId ?? '') + '">'
    + '<div class="meta"><span class="badge ' + h.tool + '">' + (h.tool === 'claude-code' ? 'claude' : h.tool) + '</span>'
    + '<span class="proj">' + esc(h.project ?? '(no project)') + '</span>'
    + '<span>' + fmtDate(h.ts) + '</span>'
    + (h.role ? '<span>[' + h.role + ']</span>' : '')
    + (h.matchedBy && h.matchedBy.includes('semantic') && !h.matchedBy.includes('fts') ? '<span style="color:var(--accent)">~semantic</span>' : '')
    + '</div>'
    + (h.title ? '<div class="title">' + esc(h.title) + '</div>' : '')
    + '<div class="snip">' + (h.snippetHtml ?? esc(h.preview ?? ''))
    + (h.extraHits ? ' <span class="extra">(+' + h.extraHits + ' more)</span>' : '')
    + (h.messageCount ? ' <span class="extra">' + h.messageCount + ' messages</span>' : '')
    + '</div></div>';
}

let seq = 0;
async function doSearch() {
  const q = $('q').value.trim();
  const my = ++seq;
  if (!q) { showRecent(); return; }
  $('results').innerHTML = '<div class="spinner">searching…</div>';
  const p = new URLSearchParams({ q, mode: $('mode').value, tool: $('tool').value, limit: 30 });
  const r = await fetch('/api/search?' + p).then(r => r.json());
  if (my !== seq) return;
  let html = '';
  if (r.note) html += '<div class="note">' + esc(r.note) + '</div>';
  html += r.hits.length
    ? r.hits.map(hitHtml).join('')
    : '<div class="empty">no matches for “' + esc(q) + '”</div>';
  $('results').innerHTML = html;
}

async function showRecent() {
  const r = await fetch('/api/recent').then(r => r.json());
  $('results').innerHTML = '<div class="sechead">Recent sessions</div>'
    + r.sessions.map(hitHtml).join('');
}

/* very small formatter: fenced code blocks only, everything else escaped text */
function renderText(t) {
  const parts = t.split(/\\n?\`\`\`[\\w-]*\\n?/);
  return parts.map((p, i) => i % 2 ? '<span class="cb">' + esc(p) + '</span>' : esc(p)).join('');
}

async function openSession(ref, messageId) {
  document.querySelectorAll('.hit').forEach(el => el.classList.toggle('active', el.dataset.ref === ref));
  $('viewer').innerHTML = '<div class="spinner">loading session…</div>';
  const r = await fetch('/api/session/' + ref).then(r => r.json());
  if (r.error) { $('viewer').innerHTML = '<div class="empty">' + esc(r.error) + '</div>'; return; }
  const s = r.session;
  $('viewer').innerHTML =
    '<div class="vhead"><h2>' + esc(s.title ?? 'Session ' + s.session_id.slice(0,8)) + '</h2>'
    + '<div class="meta"><span class="badge ' + s.tool + '">' + (s.tool === 'claude-code' ? 'claude' : s.tool) + '</span>'
    + '<span class="proj">' + esc(s.project ?? '') + '</span>'
    + '<span>' + fmtDate(s.started_at) + '</span><span>' + s.message_count + ' messages</span>'
    + '<a class="ex" style="text-decoration:none;margin-left:auto" href="/api/export/' + s.session_id + '" download>⬇ Export .md</a></div>'
    + '<div class="path">' + esc(s.source_path) + '</div></div>'
    + r.messages.map(m =>
      '<div class="msg ' + m.role + '" id="m' + m.id + '">'
      + '<div class="who">' + (m.role === 'user' ? '🧑 USER' : '🤖 ASSISTANT')
      + (m.ts ? ' <span style="font-weight:400;color:var(--dim)">' + fmtDate(m.ts) + '</span>' : '') + '</div>'
      + '<pre>' + renderText(m.text) + '</pre></div>'
    ).join('');
  if (messageId) {
    const el = $('m' + messageId);
    if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); }
  } else {
    $('viewer').scrollTop = 0;
  }
}

$('results').addEventListener('click', (e) => {
  const hit = e.target.closest('.hit');
  if (hit) openSession(hit.dataset.ref, hit.dataset.mid);
});

$('helpbtn').addEventListener('click', showHelp);
$('distillbtn').addEventListener('click', showDistill);
$('viewer').addEventListener('click', (e) => {
  const ex = e.target.closest('.ex');
  if (ex) { $('q').value = ex.textContent; doSearch(); }
});

let timer;
$('q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(doSearch, 300); });
$('mode').addEventListener('change', doSearch);
$('tool').addEventListener('change', doSearch);

$('reindex').addEventListener('click', async () => {
  $('reindex').textContent = '… indexing';
  $('reindex').disabled = true;
  const r = await fetch('/api/index', { method: 'POST' }).then(r => r.json());
  const total = (r.stats ?? []).reduce((a, s) => a + s.ingested, 0);
  $('reindex').textContent = '↻ Reindex (' + total + ' updated)';
  $('reindex').disabled = false;
  loadStats();
  doSearch();
});

loadStats();
showRecent();
showHelp();
</script>
</body>
</html>`;
