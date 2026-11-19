/**
 * account.ferretade.dev の画面（ログイン・自分の指摘・チーム・招待）。静的な HTML と、同じオリジンの JS と CSS だけ（CSP は script-src 'self'）。
 * JS は素の JS で、文字は textContent だけで出す（innerHTML は使わない）。
 * String.raw の中なので、JS ではバッククォートと ${ を使わない。
 */
export const APP_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>Ferret アカウント</title>
<link rel="stylesheet" href="/assets/app.css">
<script src="/assets/app.js" defer></script>
</head>
<body>
<div id="app"></div>
<noscript>JavaScript を有効にしてください。</noscript>
</body>
</html>
`

export const APP_CSS = String.raw`
:root {
  --bg: #f7f7f5; --surface: #ffffff; --text: #1f2328; --muted: #6b7076; --line: #e3e3df;
  --accent: #2f6fde; --accent-text: #ffffff; --danger: #c43d3d; --chip: #efefeb; --radius: 10px;
  font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17181a; --surface: #202124; --text: #e8e8e6; --muted: #9a9ea4; --line: #33353a;
    --accent: #6b9bff; --accent-text: #0f1115; --danger: #ff7a7a; --chip: #2a2c30;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); font-size: 15px; line-height: 1.6; }
button, input { font: inherit; color: inherit; }
.wrap { max-width: 880px; margin: 0 auto; padding: 0 16px 48px; }
.narrow { max-width: 400px; margin: 12vh auto 0; padding: 0 16px; }
.brand { font-weight: 700; letter-spacing: .02em; }
h1 { font-size: 20px; margin: 0 0 16px; }
h2 { font-size: 16px; margin: 24px 0 8px; }
.muted { color: var(--muted); }
.small { font-size: 13px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; }
.stack > * + * { margin-top: 12px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.grow { flex: 1 1 auto; min-width: 0; }
input[type=email], input[type=text], input[inputmode=numeric] {
  width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface);
}
input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.code { letter-spacing: .4em; font-size: 20px; text-align: center; }
.btn { padding: 9px 16px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); cursor: pointer; white-space: nowrap; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
.btn.block { width: 100%; }
.btn[disabled] { opacity: .6; cursor: default; }
.link { background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; }
.link.danger { color: var(--danger); }
.error { color: var(--danger); font-size: 14px; min-height: 1.4em; margin: 0; }
header.top { display: flex; align-items: center; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--line); margin-bottom: 16px; }
header.top .who { margin-left: auto; text-align: right; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 16px; }
.tab { background: none; border: 0; padding: 8px 12px; cursor: pointer; color: var(--muted); border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tab[aria-selected=true] { color: var(--text); border-bottom-color: var(--accent); font-weight: 600; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
.chip { border: 1px solid var(--line); background: var(--chip); border-radius: 999px; padding: 4px 12px; cursor: pointer; font-size: 13px; }
.chip[aria-pressed=true] { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.entries { list-style: none; margin: 0; padding: 0; }
.entry { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; }
.entry + .entry { margin-top: 8px; }
.entry .meta { font-size: 12px; color: var(--muted); display: flex; gap: 8px; flex-wrap: wrap; }
.entry .title { font-weight: 600; margin-top: 2px; }
.entry .text { white-space: pre-wrap; word-break: break-word; margin-top: 2px; }
.empty { text-align: center; padding: 40px 16px; color: var(--muted); }
.empty .btn { margin-top: 12px; }
.people { list-style: none; margin: 0; padding: 0; }
.people li { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--line); }
.people li:last-child { border-bottom: 0; }
.badge { font-size: 11px; border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; color: var(--muted); }
.danger-zone { margin-top: 24px; }
@media (max-width: 520px) {
  .narrow { margin-top: 8vh; }
  header.top .email { display: none; }
}
`

export const APP_JS = String.raw`(function () {
  'use strict';
  var root = document.getElementById('app');
  var state = { me: null, feedback: null, tab: 'mine', device: '', team: '', teamView: 'feedback', author: '', invite: null, inviteToken: null, inviteError: '' };

  var MESSAGES = {
    bad_email: 'メールアドレスを確かめてください', bad_code: 'コードが違います', code_expired: 'コードが切れました。もう一度送ってください',
    rate_limited: '少し待ってからもう一度お試しください', mail_failed: 'メールを送れませんでした', limit: '上限に達しています',
    forbidden: 'この操作はできません', not_found: '見つかりません', unauthorized: 'ログインし直してください', too_large: '大きすぎます'
  };
  var SOURCES = { 'visual-review': '画面の指摘', 'value-usecases': '価値ユースケース', recording: '録画' };

  function message(e) { return MESSAGES[e && e.code] || '問題が起きました。もう一度お試しください'; }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function api(method, path, body) {
    var init = { method: method, credentials: 'same-origin', headers: {} };
    if (body) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    return fetch(path, init).then(function (res) {
      return res.json().catch(function () { return { ok: false, code: 'server' }; }).then(function (data) {
        if (!res.ok || !data.ok) { var e = new Error(data.code || 'server'); e.code = data.code || 'server'; throw e; }
        return data;
      });
    });
  }

  function formatDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** 送る間はボタンを止め、失敗は下の行に出す */
  function busy(button, errorLine, work) {
    button.disabled = true;
    errorLine.textContent = '';
    return work().catch(function (e) {
      errorLine.textContent = message(e);
      if (e && e.code === 'unauthorized') { state.me = null; render(); }
    }).then(function () { button.disabled = false; });
  }

  function show(node) { root.replaceChildren(node); }

  /* ── ログイン ── */

  function loginForm(prefill, onDone) {
    var email = prefill || '';
    var box = el('div', { class: 'stack' });
    function drawEmail() {
      var input = el('input', { type: 'email', autocomplete: 'email', placeholder: 'メールアドレス', required: true, value: email });
      var error = el('p', { class: 'error', role: 'alert' });
      var button = el('button', { class: 'btn primary block', type: 'submit', text: 'コードを送る' });
      var form = el('form', { class: 'stack', onsubmit: function (ev) {
        ev.preventDefault();
        email = input.value.trim();
        busy(button, error, function () {
          return api('POST', '/v1/auth/start', { email: email, client: 'web' }).then(drawCode);
        });
      } }, [input, button, error]);
      box.replaceChildren(form);
      input.focus();
    }
    function drawCode() {
      var input = el('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', pattern: '[0-9]{6}', placeholder: '000000', class: 'code', required: true });
      var error = el('p', { class: 'error', role: 'alert' });
      var button = el('button', { class: 'btn primary block', type: 'submit', text: 'ログイン' });
      var form = el('form', { class: 'stack', onsubmit: function (ev) {
        ev.preventDefault();
        busy(button, error, function () {
          return api('POST', '/v1/auth/verify', { email: email, code: input.value.trim(), client: 'web' }).then(function (data) {
            state.me = data.me;
            onDone();
          });
        });
      } }, [
        el('p', { class: 'muted small', text: email + ' に届いた6桁のコード' }),
        input, button, error,
        el('button', { type: 'button', class: 'link small', text: 'メールアドレスを変える', onclick: drawEmail })
      ]);
      box.replaceChildren(form);
      input.focus();
    }
    drawEmail();
    return box;
  }

  function loginView() {
    show(el('main', { class: 'narrow stack' }, [
      el('h1', {}, [el('span', { class: 'brand', text: 'Ferret' }), ' にログイン']),
      el('div', { class: 'card' }, [loginForm('', load)])
    ]));
  }

  /* ── 招待 ── */

  function inviteView() {
    var inv = state.invite;
    if (!inv) {
      show(el('main', { class: 'narrow stack' }, [
        el('h1', { text: '招待が見つかりません' }),
        el('p', { class: 'muted', text: '期限が切れたか、取り消されました。招待した人にもう一度送ってもらってください。' }),
        el('a', { class: 'btn', href: '/', text: 'トップへ' })
      ]));
      return;
    }
    var head = [
      el('h1', { text: '「' + inv.teamName + '」への招待' }),
      el('p', { class: 'muted small', text: (inv.inviter ? inv.inviter + ' さんから・' : '') + inv.email })
    ];
    if (!state.me) {
      show(el('main', { class: 'narrow stack' }, head.concat([el('div', { class: 'card' }, [loginForm(inv.email, renderAfterLogin)])])));
      return;
    }
    if (state.me.email !== inv.email) {
      var error0 = el('p', { class: 'error', role: 'alert' });
      var out = el('button', { class: 'btn primary block', type: 'button', text: inv.email + ' でログインし直す' });
      out.addEventListener('click', function () { busy(out, error0, function () { return api('POST', '/v1/auth/logout').then(function () { state.me = null; render(); }); }); });
      show(el('main', { class: 'narrow stack' }, head.concat([
        el('p', { text: 'いまは ' + state.me.email + ' でログインしています。' }), out, error0
      ])));
      return;
    }
    var error = el('p', { class: 'error', role: 'alert' });
    var join = el('button', { class: 'btn primary block', type: 'button', text: '参加する' });
    join.addEventListener('click', function () {
      busy(join, error, function () {
        return api('POST', '/v1/invites/' + state.inviteToken + '/accept').then(function (data) {
          state.inviteToken = null; state.invite = null;
          state.tab = 'teams'; state.team = data.teamId; state.teamView = 'feedback';
          history.replaceState(null, '', '/');
          return load();
        });
      });
    });
    show(el('main', { class: 'narrow stack' }, head.concat([join, error])));
  }

  function renderAfterLogin() { render(); }

  /* ── ログインのあと ── */

  function load() {
    return Promise.all([api('GET', '/v1/me'), api('GET', '/v1/feedback')]).then(function (r) {
      state.me = r[0].me;
      state.feedback = r[1];
      render();
    }, function (e) {
      if (e && e.code === 'unauthorized') { state.me = null; render(); return; }
      show(el('main', { class: 'narrow stack' }, [el('p', { class: 'error', text: message(e) }), el('button', { class: 'btn', type: 'button', text: '読み直す', onclick: load })]));
    });
  }

  function render() {
    if (state.inviteToken) { inviteView(); return; }
    if (!state.me) { loginView(); return; }
    if (!state.feedback) { load(); return; }
    var me = state.me;
    var who = el('div', { class: 'who' }, [
      el('button', { class: 'link', type: 'button', title: '名前を変える', text: me.name, onclick: renameMe }),
      el('span', { class: 'muted small email', text: ' ' + me.email })
    ]);
    var logoutError = el('span', { class: 'error' });
    var logout = el('button', { class: 'btn', type: 'button', text: 'ログアウト' });
    logout.addEventListener('click', function () {
      busy(logout, logoutError, function () { return api('POST', '/v1/auth/logout').then(function () { state.me = null; state.feedback = null; render(); }); });
    });
    var tabs = el('div', { class: 'tabs', role: 'tablist' }, [
      tab('mine', '自分の指摘'), tab('teams', 'チーム')
    ]);
    show(el('div', { class: 'wrap' }, [
      el('header', { class: 'top' }, [el('span', { class: 'brand', text: 'Ferret' }), who, logout, logoutError]),
      tabs,
      state.tab === 'mine' ? mineView() : teamsView()
    ]));
  }

  function tab(id, label) {
    return el('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': String(state.tab === id), text: label, onclick: function () { state.tab = id; render(); } });
  }

  function renameMe() {
    var name = window.prompt('表示する名前', state.me.name);
    if (name === null || !name.trim()) return;
    api('PATCH', '/v1/me', { name: name.trim() }).then(function (data) { state.me = data.me; state.feedback = null; render(); }, function (e) { window.alert(message(e)); });
  }

  function chips(items, selected, onPick) {
    return el('div', { class: 'chips' }, items.map(function (it) {
      return el('button', { class: 'chip', type: 'button', 'aria-pressed': String(selected === it.id), text: it.label + ' ' + it.count, onclick: function () { onPick(it.id); } });
    }));
  }

  function entryList(entries, showAuthor) {
    return el('ul', { class: 'entries' }, entries.map(function (e) {
      var meta = [e.project, SOURCES[e.source] || e.source, formatDate(e.at), showAuthor ? e.author.name : e.deviceName].filter(Boolean);
      return el('li', { class: 'entry' }, [
        el('div', { class: 'meta' }, meta.map(function (m) { return el('span', { text: m }); })),
        e.title ? el('div', { class: 'title', text: e.title }) : null,
        el('div', { class: 'text', text: e.text })
      ]);
    }));
  }

  function mineView() {
    var entries = state.feedback.mine;
    if (!entries.length) {
      return el('div', { class: 'empty' }, [
        el('p', { text: 'まだ指摘がありません' }),
        el('p', { class: 'small', text: 'Ferret の設定で、このメールアドレスでログインすると届きます。' })
      ]);
    }
    var devices = {};
    entries.forEach(function (e) { devices[e.deviceId] = devices[e.deviceId] || { id: e.deviceId, label: e.deviceName, count: 0 }; devices[e.deviceId].count++; });
    var list = Object.keys(devices).map(function (k) { return devices[k]; });
    if (state.device && !devices[state.device]) state.device = '';
    var shown = state.device ? entries.filter(function (e) { return e.deviceId === state.device; }) : entries;
    return el('section', {}, [
      list.length > 1 ? chips([{ id: '', label: 'すべて', count: entries.length }].concat(list), state.device, function (id) { state.device = id; render(); }) : null,
      entryList(shown, false)
    ]);
  }

  function teamsView() {
    var teams = state.me.teams;
    if (!teams.length) {
      return el('div', { class: 'empty' }, [
        el('p', { text: 'チームを作ると、メンバーの指摘を見られます' }),
        createTeamForm()
      ]);
    }
    if (!teams.some(function (t) { return t.id === state.team; })) state.team = teams[0].id;
    var team = teams.filter(function (t) { return t.id === state.team; })[0];
    var picker = el('div', { class: 'chips' }, teams.map(function (t) {
      return el('button', { class: 'chip', type: 'button', 'aria-pressed': String(t.id === state.team), text: t.name, onclick: function () { state.team = t.id; state.author = ''; render(); } });
    }).concat([el('button', { class: 'chip', type: 'button', text: '＋ チーム', 'aria-pressed': String(state.team === '+'), onclick: function () { state.team = '+'; renderNewTeam(); } })]));
    var sub = el('div', { class: 'tabs', role: 'tablist' }, [
      subTab('feedback', '指摘'), subTab('members', 'メンバー ' + team.members.length)
    ]);
    return el('section', {}, [picker, sub, state.teamView === 'members' ? membersView(team) : teamFeedbackView(team)]);
  }

  function renderNewTeam() {
    show(el('div', { class: 'wrap' }, [
      el('header', { class: 'top' }, [el('span', { class: 'brand', text: 'Ferret' })]),
      el('div', { class: 'narrow stack', style: null }, [
        el('h1', { text: '新しいチーム' }), createTeamForm(),
        el('button', { class: 'link small', type: 'button', text: 'やめる', onclick: function () { state.team = ''; render(); } })
      ])
    ]));
  }

  function subTab(id, label) {
    return el('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': String(state.teamView === id), text: label, onclick: function () { state.teamView = id; render(); } });
  }

  function createTeamForm() {
    var input = el('input', { type: 'text', placeholder: 'チームの名前', maxlength: '60', required: true });
    var error = el('p', { class: 'error', role: 'alert' });
    var button = el('button', { class: 'btn primary', type: 'submit', text: '作る' });
    return el('form', { class: 'stack', onsubmit: function (ev) {
      ev.preventDefault();
      busy(button, error, function () {
        return api('POST', '/v1/teams', { name: input.value.trim() }).then(function (data) {
          state.tab = 'teams'; state.team = data.team.id; state.teamView = 'members';
          return load();
        });
      });
    } }, [el('div', { class: 'row' }, [el('div', { class: 'grow' }, [input]), button]), error]);
  }

  function teamFeedbackView(team) {
    var block = (state.feedback.teams || []).filter(function (t) { return t.id === team.id; })[0];
    var entries = block ? block.entries : [];
    if (!entries.length) {
      if (team.members.length < 2 && team.role === 'owner') {
        return el('div', { class: 'empty' }, [
          el('p', { text: 'メンバーを招待すると、ここに指摘が並びます' }),
          el('button', { class: 'btn primary', type: 'button', text: '招待する', onclick: function () { state.teamView = 'members'; render(); } })
        ]);
      }
      return el('div', { class: 'empty' }, [el('p', { text: 'メンバーの指摘はまだありません' })]);
    }
    var authors = {};
    entries.forEach(function (e) { authors[e.author.id] = authors[e.author.id] || { id: e.author.id, label: e.author.name, count: 0 }; authors[e.author.id].count++; });
    var list = Object.keys(authors).map(function (k) { return authors[k]; });
    if (state.author && !authors[state.author]) state.author = '';
    var shown = state.author ? entries.filter(function (e) { return e.author.id === state.author; }) : entries;
    return el('section', {}, [
      list.length > 1 ? chips([{ id: '', label: 'すべて', count: entries.length }].concat(list), state.author, function (id) { state.author = id; render(); }) : null,
      entryList(shown, true)
    ]);
  }

  function act(button, error, method, path, body, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    busy(button, error, function () { return api(method, path, body).then(load); });
  }

  function membersView(team) {
    var me = state.me;
    var owner = team.role === 'owner';
    var error = el('p', { class: 'error', role: 'alert' });
    var base = '/v1/teams/' + team.id;
    var people = el('ul', { class: 'people' }, team.members.map(function (m) {
      var self = m.id === me.id;
      var action = null;
      if (self && !owner) {
        action = el('button', { class: 'link danger small', type: 'button', text: '抜ける' });
        action.addEventListener('click', function () { act(action, error, 'DELETE', base + '/members/' + m.id, null, '「' + team.name + '」から抜けますか？'); });
      } else if (!self && owner) {
        action = el('button', { class: 'link danger small', type: 'button', text: '外す' });
        action.addEventListener('click', function () { act(action, error, 'DELETE', base + '/members/' + m.id, null, m.name + ' さんを外しますか？'); });
      }
      return el('li', {}, [
        el('div', { class: 'grow' }, [el('div', { text: m.name + (self ? '（自分）' : '') }), el('div', { class: 'muted small', text: m.email })]),
        m.role === 'owner' ? el('span', { class: 'badge', text: '持ち主' }) : null,
        action
      ]);
    }));
    var parts = [el('div', { class: 'card' }, [people])];
    if (owner) {
      var input = el('input', { type: 'email', placeholder: '招待するメールアドレス', required: true });
      var inviteError = el('p', { class: 'error', role: 'alert' });
      var send = el('button', { class: 'btn primary', type: 'submit', text: '招待する' });
      parts.push(el('form', { class: 'stack', style: null, onsubmit: function (ev) {
        ev.preventDefault();
        busy(send, inviteError, function () { return api('POST', base + '/invites', { email: input.value.trim() }).then(load); });
      } }, [el('h2', { text: '招待' }), el('div', { class: 'row' }, [el('div', { class: 'grow' }, [input]), send]), inviteError]));
      var invites = team.invites || [];
      if (invites.length) {
        parts.push(el('ul', { class: 'people' }, invites.map(function (i) {
          var cancel = el('button', { class: 'link small', type: 'button', text: '取り消す' });
          cancel.addEventListener('click', function () { act(cancel, error, 'DELETE', base + '/invites', { email: i.email }); });
          return el('li', {}, [el('div', { class: 'grow' }, [el('div', { text: i.email }), el('div', { class: 'muted small', text: '返事待ち・' + formatDate(i.expiresAt) + ' まで' })]), cancel]);
        })));
      }
      var rename = el('button', { class: 'link small', type: 'button', text: 'チームの名前を変える' });
      rename.addEventListener('click', function () {
        var name = window.prompt('チームの名前', team.name);
        if (name === null || !name.trim()) return;
        act(rename, error, 'PATCH', base, { name: name.trim() });
      });
      var remove = el('button', { class: 'link danger small', type: 'button', text: 'チームを消す' });
      remove.addEventListener('click', function () { act(remove, error, 'DELETE', base, null, '「' + team.name + '」を消しますか？メンバー全員が見られなくなります。'); });
      parts.push(el('div', { class: 'row danger-zone' }, [rename, remove]));
    }
    parts.push(error);
    return el('section', { class: 'stack' }, parts);
  }

  /* ── はじめ ── */

  function start() {
    var m = /^\/invite\/([0-9a-f]{64})$/.exec(location.pathname);
    var invite = Promise.resolve();
    if (location.pathname.indexOf('/invite/') === 0) {
      state.inviteToken = m ? m[1] : 'x';
      invite = m ? api('GET', '/v1/invites/' + m[1]).then(function (d) { state.invite = d; }, function () { state.invite = null; }) : Promise.resolve();
    }
    invite.then(function () {
      return api('GET', '/v1/me').then(function (d) { state.me = d.me; }, function () { state.me = null; });
    }).then(function () {
      if (state.inviteToken || !state.me) { render(); return; }
      load();
    });
  }

  start();
})();
`
