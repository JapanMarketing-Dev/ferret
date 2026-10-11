/**
 * スマホから操作（src/main/mobileRemote.ts）でスマホに渡すページ。素の HTML・CSS・JS で、ビルドも依存も持たない。
 *
 * CSP（default-src 'self'）でインラインのスクリプト・スタイルを禁じるので、JS と CSS は別のファイル（/app.js・/app.css）で返す。
 * このページと JS・CSS には秘密を含めない（合言葉なしで返す）。合言葉は URL のフラグメント（#t=…）から JS が読み、
 * API へは Authorization: Bearer で送る。言語はサーバーが <html lang> に入れ、JS がそれで文言を選ぶ。
 *
 * JS はテンプレート文字列の中に書くので、JS の側では ` と ${ を使わない。
 */

export type RemotePageLocale = 'ja' | 'en'

export function remotePageHtml(locale: RemotePageLocale): string {
  const title = locale === 'ja' ? 'Ferret リモート' : 'Ferret Remote'
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f6f5f2" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#16171a" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<title>${title}</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header class="bar">
  <button id="back" class="bar__back" type="button" hidden aria-label="Back">&#8249;</button>
  <div class="bar__title">
    <div id="title" class="bar__name">${title}</div>
    <div id="subtitle" class="bar__sub"></div>
  </div>
  <span id="badge" class="badge" hidden></span>
  <span id="conn" class="conn" aria-live="polite"></span>
</header>
<main id="app">
  <section id="view-list" class="view">
    <div id="notice" class="notice" hidden></div>
    <ul id="terminals" class="cards"></ul>
    <p id="empty" class="muted center" hidden></p>
    <details id="checklist" class="checklist" hidden>
      <summary id="checklist-title"></summary>
      <ul id="checklist-items"></ul>
    </details>
  </section>
  <section id="view-term" class="view term" hidden>
    <div class="screen-wrap">
      <pre id="screen" class="screen wrap" tabindex="0"></pre>
      <button id="jump" class="jump" type="button" hidden>&#8595;</button>
    </div>
    <div class="keys" role="toolbar">
      <button type="button" data-key="enter">Enter</button>
      <button type="button" data-key="esc">Esc</button>
      <button type="button" data-key="up" aria-label="Up">&#8593;</button>
      <button type="button" data-key="down" aria-label="Down">&#8595;</button>
      <button type="button" data-key="1">1</button>
      <button type="button" data-key="2">2</button>
      <button type="button" data-key="3">3</button>
      <button type="button" data-key="tab">Tab</button>
      <button type="button" data-key="ctrl-c" class="danger">Ctrl+C</button>
      <button type="button" id="wrap" class="toggle on" aria-pressed="true"></button>
    </div>
    <form id="composer" class="composer">
      <textarea id="text" rows="2" maxlength="8000" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
      <button id="send" type="submit" class="primary"></button>
    </form>
  </section>
</main>
<div id="toast" class="toast" role="status" hidden></div>
<script src="/app.js"></script>
</body>
</html>
`
}

export const REMOTE_PAGE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#e8743b"/><path d="M20 46V18h24v6H27v6h14v6H27v10z" fill="#fff"/></svg>
`

export const REMOTE_PAGE_CSS = `:root {
  --bg: #f6f5f2; --panel: #ffffff; --text: #1d1d1f; --muted: #6b6b70; --line: #e3e1dc;
  --accent: #e8743b; --accent-text: #ffffff; --screen-bg: #ffffff; --screen-text: #1d1d1f;
  --working: #2f7de1; --blocked: #d9480f; --idle: #2b8a3e; --unknown: #8a8a8e; --danger: #c92a2a;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16171a; --panel: #202226; --text: #ececee; --muted: #9a9aa2; --line: #303238;
    --accent: #f08a52; --accent-text: #16171a; --screen-bg: #0f1012; --screen-text: #dcdcdf;
    --working: #5c9cf0; --blocked: #ff8a4c; --idle: #51cf66; --unknown: #8a8a8e; --danger: #ff6b6b;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--bg); color: var(--text);
  font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
  display: flex; flex-direction: column; height: 100dvh; -webkit-text-size-adjust: 100%;
}
button, textarea { font: inherit; color: inherit; }
.bar {
  display: flex; align-items: center; gap: 8px; min-height: 52px;
  padding: calc(env(safe-area-inset-top) + 6px) 16px 6px; border-bottom: 1px solid var(--line); background: var(--panel);
}
.bar__back { border: 0; background: none; font-size: 30px; line-height: 1; padding: 0 8px 4px 0; cursor: pointer; }
.bar__title { flex: 1; min-width: 0; }
.bar__name { font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar__sub { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.conn { width: 8px; height: 8px; border-radius: 50%; background: var(--unknown); flex: none; }
.conn.ok { background: var(--idle); }
.conn.bad { background: var(--danger); }
main { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.view { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 16px calc(env(safe-area-inset-bottom) + 16px); }
.view[hidden] { display: none; }
.cards { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.card {
  display: flex; align-items: center; gap: 12px; width: 100%; text-align: left;
  padding: 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); cursor: pointer;
}
.card:active { transform: scale(0.99); }
.card__main { flex: 1; min-width: 0; }
.card__title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card__meta { color: var(--muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.badge {
  flex: none; font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 999px;
  color: var(--state, var(--unknown)); border: 1px solid currentColor;
}
.badge[data-state="working"] { --state: var(--working); }
.badge[data-state="blocked"] { --state: var(--blocked); background: color-mix(in srgb, var(--blocked) 14%, transparent); }
.badge[data-state="idle"] { --state: var(--idle); }
.muted { color: var(--muted); }
.center { text-align: center; padding: 32px 8px; }
.notice { padding: 14px; border-radius: 12px; border: 1px solid var(--danger); color: var(--danger); margin-bottom: 12px; }
.checklist { margin-top: 18px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); padding: 10px 14px; }
.checklist summary { font-weight: 600; cursor: pointer; }
.checklist ul { padding-left: 18px; margin: 8px 0 0; }
.checklist li { margin: 6px 0; overflow-wrap: anywhere; }
.checklist .key { font-weight: 600; margin-right: 6px; }
.checklist .answer { color: var(--idle); font-size: 13px; }
.term { display: flex; flex-direction: column; padding: 0; overflow: hidden; }
.screen-wrap { position: relative; flex: 1; min-height: 0; }
.screen {
  position: absolute; inset: 0; margin: 0; padding: 10px 12px; overflow: auto; background: var(--screen-bg); color: var(--screen-text);
  font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono", monospace; white-space: pre;
  -webkit-overflow-scrolling: touch; overscroll-behavior: contain;
}
.screen.wrap { white-space: pre-wrap; overflow-wrap: anywhere; }
.jump {
  position: absolute; right: 14px; bottom: 12px; width: 40px; height: 40px; border-radius: 50%;
  border: 1px solid var(--line); background: var(--panel); box-shadow: 0 2px 8px rgba(0,0,0,.2); cursor: pointer;
}
.keys {
  display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--line); background: var(--panel);
}
.keys button {
  flex: 1 0 auto; min-width: 44px; height: 38px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--line);
  background: var(--bg); font-size: 14px; cursor: pointer;
}
.keys button:active { background: var(--line); }
.keys button.danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, var(--line)); }
.keys button.toggle.on { color: var(--accent); border-color: var(--accent); }
.composer {
  display: flex; gap: 8px; align-items: flex-end; padding: 8px 12px calc(env(safe-area-inset-bottom) + 10px); background: var(--panel);
}
.composer textarea {
  flex: 1; min-width: 0; resize: none; max-height: 30vh; padding: 9px 11px; border-radius: 10px; border: 1px solid var(--line);
  background: var(--bg); font-size: 16px;
}
.composer textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
button.primary {
  flex: none; height: 42px; padding: 0 18px; border: 0; border-radius: 10px; background: var(--accent); color: var(--accent-text);
  font-weight: 650; cursor: pointer;
}
button:disabled { opacity: .5; }
.toast {
  position: fixed; left: 16px; right: 16px; bottom: calc(env(safe-area-inset-bottom) + 120px); margin: 0 auto; max-width: 480px;
  padding: 11px 14px; border-radius: 10px; background: var(--text); color: var(--bg); font-size: 14px; text-align: center;
  box-shadow: 0 4px 16px rgba(0,0,0,.25);
}
.toast.bad { background: var(--danger); color: #fff; }
`

export const REMOTE_PAGE_JS = `(function () {
  'use strict';
  var JA = document.documentElement.lang === 'ja';
  var S = JA ? {
    noToken: 'この画面は Ferret の設定（スマホから操作）の QR コードか URL から開いてください。',
    badToken: 'リンクが古くなっています。Ferret の設定で新しい QR コードを読み取ってください。',
    blocked: '合言葉の誤りが続いたので、しばらく受け付けません。少し待ってから開き直してください。',
    offline: 'Ferret に届きません。PC が起きていて、同じ Wi‑Fi か Tailscale につながっているか確かめてください。',
    empty: '開いているターミナルはありません。',
    working: '作業中', blocked2: '確認待ち', idle: '待機中', unknown: '—',
    shell: 'シェル', send: '送信', placeholder: 'Agent への指示…', wrap: '折り返し',
    sent: '送りました', ctrlc: 'Ctrl+C を送って、実行中の処理を止めますか？', gone: 'このターミナルは閉じられました。',
    checklist: '人が確認すること', failed: '送れませんでした'
  } : {
    noToken: 'Open this page from the QR code or link in Ferret Settings > Phone remote.',
    badToken: 'This link is no longer valid. Scan the new QR code in Ferret Settings.',
    blocked: 'Too many wrong links. Wait a few minutes, then open the link again.',
    offline: 'Cannot reach Ferret. Check that the computer is awake and on the same Wi-Fi or Tailscale.',
    empty: 'No terminals are open.',
    working: 'Working', blocked2: 'Waiting for you', idle: 'Idle', unknown: '—',
    shell: 'Shell', send: 'Send', placeholder: 'Message to the agent…', wrap: 'Wrap',
    sent: 'Sent', ctrlc: 'Send Ctrl+C and stop what is running?', gone: 'This terminal was closed.',
    checklist: 'For you to check', failed: 'Could not send'
  };
  var STATE_LABEL = { working: S.working, blocked: S.blocked2, idle: S.idle, unknown: S.unknown };

  function $(id) { return document.getElementById(id); }
  function readToken() {
    var m = /(?:^|[#&])t=([A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash);
    if (m) { try { localStorage.setItem('ferret-remote-token', m[1]); } catch (e) {} return m[1]; }
    try { return localStorage.getItem('ferret-remote-token'); } catch (e) { return null; }
  }
  var token = readToken();
  var current = null;
  var terminals = [];
  var timer = null;
  var stopped = false;
  var wrap = true;
  try { wrap = localStorage.getItem('ferret-remote-wrap') !== '0'; } catch (e) {}

  function api(method, path, body) {
    var opts = { method: method, headers: { 'Authorization': 'Bearer ' + token }, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function (res) {
      setConn(true);
      if (res.status === 401) { stop(S.badToken); try { localStorage.removeItem('ferret-remote-token'); } catch (e) {} throw new Error('401'); }
      if (res.status === 429) { stop(S.blocked); throw new Error('429'); }
      return res.json().catch(function () { return {}; }).then(function (data) { return { status: res.status, data: data }; });
    }, function (err) { setConn(false); throw err; });
  }
  function setConn(ok) { var c = $('conn'); c.className = 'conn ' + (ok ? 'ok' : 'bad'); c.title = ok ? '' : S.offline; }
  function stop(message) {
    stopped = true; clearTimeout(timer);
    showList();
    var n = $('notice'); n.textContent = message; n.hidden = false;
    $('terminals').innerHTML = ''; $('empty').hidden = true; $('checklist').hidden = true;
  }
  var toastTimer = null;
  function toast(message, bad) {
    var el = $('toast'); el.textContent = message; el.className = 'toast' + (bad ? ' bad' : ''); el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.hidden = true; }, 2600);
  }
  function badge(el, state) { el.dataset.state = state; el.textContent = STATE_LABEL[state] || S.unknown; }

  function renderList() {
    var ul = $('terminals'); ul.innerHTML = '';
    $('empty').hidden = terminals.length > 0; $('empty').textContent = S.empty;
    terminals.forEach(function (t) {
      var li = document.createElement('li');
      var b = document.createElement('button'); b.type = 'button'; b.className = 'card';
      var main = document.createElement('div'); main.className = 'card__main';
      var title = document.createElement('div'); title.className = 'card__title'; title.textContent = t.title;
      var meta = document.createElement('div'); meta.className = 'card__meta'; meta.textContent = t.project + ' · ' + (t.agent || S.shell);
      main.appendChild(title); main.appendChild(meta);
      b.appendChild(main);
      // 状態の分からないもの（素のシェル）には札を付けない
      if (t.state !== 'unknown') { var st = document.createElement('span'); st.className = 'badge'; badge(st, t.state); b.appendChild(st); }
      b.addEventListener('click', function () { openTerminal(t.id); });
      li.appendChild(b); ul.appendChild(li);
    });
  }
  function loadList() {
    return api('GET', '/api/terminals').then(function (r) {
      terminals = (r.data && r.data.terminals) || [];
      if (!current) renderList();
    });
  }
  function loadChecklist() {
    return api('GET', '/api/checklist').then(function (r) {
      var items = (r.data && r.data.items) || [];
      var box = $('checklist'); box.hidden = items.length === 0;
      $('checklist-title').textContent = S.checklist + ' (' + items.length + ')';
      var ul = $('checklist-items'); ul.innerHTML = '';
      items.forEach(function (it) {
        var li = document.createElement('li');
        var k = document.createElement('span'); k.className = 'key'; k.textContent = it.key; li.appendChild(k);
        li.appendChild(document.createTextNode([it.label, it.note].filter(Boolean).join(' — ')));
        if (it.answer) { var a = document.createElement('div'); a.className = 'answer'; a.textContent = '✓ ' + it.answer; li.appendChild(a); }
        ul.appendChild(li);
      });
    }).catch(function () {});
  }

  function nearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 48; }
  function loadScreen() {
    var id = current;
    return api('GET', '/api/terminals/' + encodeURIComponent(id) + '/screen').then(function (r) {
      if (current !== id) return;
      if (r.status === 404) { toast(S.gone, true); showList(); return; }
      var d = r.data || {};
      $('title').textContent = d.title || ''; $('subtitle').textContent = (d.project || '') + ' · ' + (d.agent || S.shell);
      var b = $('badge'); b.hidden = !d.state || d.state === 'unknown'; badge(b, d.state || 'unknown');
      var pre = $('screen'); var stick = nearBottom(pre) || pre.dataset.fresh === '1';
      if (pre.textContent !== d.text) pre.textContent = d.text || '';
      if (stick) pre.scrollTop = pre.scrollHeight;
      pre.dataset.fresh = '0';
      $('jump').hidden = nearBottom(pre);
    });
  }

  function tick() {
    clearTimeout(timer);
    if (stopped || document.hidden) return;
    var p = current ? loadScreen() : loadList();
    p.catch(function () {}).then(function () { if (!stopped) timer = setTimeout(tick, current ? 2000 : 3000); });
  }

  function openTerminal(id) {
    current = id;
    $('view-list').hidden = true; $('view-term').hidden = false; $('back').hidden = false;
    var pre = $('screen'); pre.textContent = ''; pre.dataset.fresh = '1';
    var t = terminals.filter(function (x) { return x.id === id; })[0];
    $('title').textContent = t ? t.title : ''; $('subtitle').textContent = t ? t.project : '';
    // 端末の「戻る」（スワイプ）で一覧へ戻れるよう、履歴を1つ積む（URL は変えない。合言葉のフラグメントもそのまま）
    history.pushState({ id: id }, '');
    tick();
  }
  function showList() {
    current = null;
    $('view-list').hidden = false; $('view-term').hidden = true; $('back').hidden = true; $('badge').hidden = true;
    $('title').textContent = JA ? 'Ferret リモート' : 'Ferret Remote'; $('subtitle').textContent = '';
    renderList();
  }

  function sendKey(key) {
    if (!current) return;
    if (key === 'ctrl-c' && !confirm(S.ctrlc)) return;
    api('POST', '/api/terminals/' + encodeURIComponent(current) + '/key', { key: key }).then(function (r) {
      if (r.status !== 200) toast((r.data && r.data.message) || S.failed, true);
      setTimeout(tick, 300);
    }).catch(function () {});
  }

  $('back').addEventListener('click', function () { if (history.state && history.state.id) history.back(); else showList(); tick(); });
  window.addEventListener('popstate', function () { showList(); tick(); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-key]'), function (b) {
    b.addEventListener('click', function () { sendKey(b.getAttribute('data-key')); });
  });
  $('jump').addEventListener('click', function () { var pre = $('screen'); pre.scrollTop = pre.scrollHeight; $('jump').hidden = true; });
  $('screen').addEventListener('scroll', function () { $('jump').hidden = nearBottom($('screen')); });
  function applyWrap() {
    $('screen').classList.toggle('wrap', wrap); var w = $('wrap'); w.classList.toggle('on', wrap); w.setAttribute('aria-pressed', String(wrap)); w.textContent = S.wrap;
  }
  $('wrap').addEventListener('click', function () { wrap = !wrap; try { localStorage.setItem('ferret-remote-wrap', wrap ? '1' : '0'); } catch (e) {} applyWrap(); });
  applyWrap();
  $('text').placeholder = S.placeholder; $('send').textContent = S.send;
  $('composer').addEventListener('submit', function (e) {
    e.preventDefault();
    var box = $('text'); var text = box.value.trim(); if (!text || !current) return;
    var btn = $('send'); btn.disabled = true;
    api('POST', '/api/terminals/' + encodeURIComponent(current) + '/send', { text: text }).then(function (r) {
      var ok = r.status === 200 && r.data && r.data.ok;
      if (ok) box.value = '';
      toast((r.data && r.data.message) || (ok ? S.sent : S.failed), !ok);
      setTimeout(tick, 400);
    }).catch(function () { toast(S.offline, true); }).then(function () { btn.disabled = false; });
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });

  if (!token) { stop(S.noToken); return; }
  loadChecklist();
  tick();
})();
`
