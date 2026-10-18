import type { PageContent } from './contract'
import { INTEREST_LIMITS } from './contract'
import type { PosthogConfig } from './posthog'

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
}

/** HTML の本文と属性値の両方で安全にする */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (c) => ESCAPES[c] ?? c)
}

const LS = String.fromCharCode(0x2028)
const LINE_SEPARATORS = /[\u2028\u2029]/g

/** <script> 内に埋め込む JSON。</script> や行区切り文字で抜けられないようにする */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(LINE_SEPARATORS, (c) => (c === LS ? '\\u2028' : '\\u2029'))
}

const CSS =
  ':root{color-scheme:light;--fg:#1a1a1a;--mut:#454545;--ac:#0b5cad}' +
  '*{box-sizing:border-box}' +
  'body{margin:0;font:16px/1.7 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;color:var(--fg);background:#fff}' +
  'main,footer{max-width:40rem;margin:0 auto;padding:1.5rem 1rem}' +
  'h1{font-size:1.75rem;line-height:1.4;margin:1rem 0}' +
  'h2{font-size:1.25rem;margin:2rem 0 .5rem}' +
  '.pre{white-space:pre-line}' +
  '.sub{color:var(--mut);font-size:1.125rem}' +
  'ul{padding-left:1.25rem}' +
  '.price{font-weight:700;font-size:1.25rem}' +
  '.cta,button{display:inline-block;min-height:48px;background:var(--ac);color:#fff;border:0;border-radius:.5rem;padding:.75rem 1.5rem;font:inherit;font-weight:700;text-decoration:none;cursor:pointer}' +
  'a{color:var(--ac)}' +
  'a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid #b35900;outline-offset:2px}' +
  'label{display:block;font-weight:600;margin-top:1rem}' +
  '.f{display:block;width:100%;padding:.625rem;border:1px solid #6b6b6b;border-radius:.375rem;font:inherit;color:inherit;background:#fff}' +
  '.chk{display:flex;gap:.5rem;align-items:flex-start;margin:1.25rem 0}' +
  '.chk input{margin-top:.45rem;width:1.25rem;height:1.25rem;flex:none}' +
  '.chk label{margin:0;font-weight:400}' +
  '.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}' +
  'footer{color:var(--mut);font-size:.875rem;border-top:1px solid #ddd}'

function layout(opts: { title: string; description?: string; nonce: string; body: string; tail?: string }): string {
  const desc = opts.description ? `<meta name="description" content="${escapeHtml(opts.description)}">` : ''
  return (
    '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${escapeHtml(opts.title)}</title>${desc}` +
    `<style nonce="${opts.nonce}">${CSS}</style></head><body>${opts.body}${opts.tail ?? ''}</body></html>`
  )
}

function para(text: string, cls?: string): string {
  if (!text) return ''
  const c = cls ? ` class="${cls}"` : ''
  return `<p${c}>${escapeHtml(text)}</p>`
}

export interface RenderPageOptions {
  slug: string
  title: string
  content: PageContent
  nonce: string
  posthog: PosthogConfig | null
}

/** 公開ページ。文面はすべてエスケープし、管理者からの生 HTML は一切出さない。 */
export function renderPage(opts: RenderPageOptions): string {
  const { slug, content: c, nonce } = opts
  const base = `/p/${slug}`
  const bullets = c.bullets.length > 0 ? `<ul>${c.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>` : ''
  const body =
    '<main><header>' +
    `<h1>${escapeHtml(c.headline)}</h1>${para(c.subhead, 'sub pre')}</header>` +
    bullets +
    para(c.priceText, 'price') +
    `<p><a id="cta" class="cta" href="#interest">${escapeHtml(c.ctaLabel)}</a></p>` +
    '<section id="interest" aria-labelledby="ih"><h2 id="ih">ご相談・お問い合わせ</h2>' +
    para(c.formIntro, 'pre') +
    `<form method="post" action="${base}/interest">` +
    `<label for="name">お名前</label><input class="f" id="name" name="name" type="text" maxlength="${INTEREST_LIMITS.name}" autocomplete="name">` +
    `<label for="company">会社名</label><input class="f" id="company" name="company" type="text" maxlength="${INTEREST_LIMITS.company}" autocomplete="organization">` +
    `<label for="email">メールアドレス</label><input class="f" id="email" name="email" type="email" required maxlength="${INTEREST_LIMITS.email}" autocomplete="email">` +
    `<label for="message">ご質問・ご要望</label><textarea class="f" id="message" name="message" rows="4" maxlength="${INTEREST_LIMITS.message}"></textarea>` +
    '<div class="hp" aria-hidden="true"><label for="website">この欄は空のままにしてください</label><input id="website" name="website" type="text" tabindex="-1" autocomplete="off"></div>' +
    `<div class="chk"><input id="consent" name="consent" type="checkbox" value="yes" required><label for="consent" class="pre">${escapeHtml(c.consentText)}</label></div>` +
    '<button type="submit">送信する</button></form></section></main>' +
    (c.footerNote ? `<footer>${para(c.footerNote, 'pre')}</footer>` : '')
  const cta =
    `<script nonce="${nonce}">document.getElementById("cta").addEventListener("click",function(){` +
    `try{fetch(${scriptJson(`${base}/cta`)},{method:"POST",keepalive:true,credentials:"same-origin"}).catch(function(){})}catch(e){}});</script>`
  return layout({
    title: opts.title,
    description: c.subhead || c.headline,
    nonce,
    body,
    tail: cta + (opts.posthog ? posthogScript(opts.posthog, nonce) : ''),
  })
}

/**
 * PostHog の読み込み（公式スニペットを必要な関数だけに縮めたもの）。
 * - person_profiles: identified_only（匿名訪問者のプロフィールを作らない）
 * - autocapture は CTA（#cta）のクリックだけ
 * - セッション録画では入力欄をすべて伏せる
 */
export function posthogScript(ph: PosthogConfig, nonce: string): string {
  const options = {
    api_host: ph.apiHost,
    person_profiles: 'identified_only',
    persistence: 'memory',
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: { dom_event_allowlist: ['click'], css_selector_allowlist: ['#cta'] },
    mask_all_text: false,
    session_recording: { maskAllInputs: true, maskInputOptions: { password: true, email: true, text: true } },
    disable_surveys: true,
    advanced_disable_toolbar_metrics: true,
  }
  return (
    `<script nonce="${nonce}">(function(w,d,k,o,src){var p=w.posthog=w.posthog||[];if(p.__SV)return;p._i=[];` +
    'p.init=function(a,b,c){var s=d.createElement("script");s.async=true;s.crossOrigin="anonymous";s.src=src;d.head.appendChild(s);' +
    'var u=p;["capture","identify","register","reset","opt_out_capturing","opt_in_capturing"].forEach(function(m){u[m]=function(){u.push([m].concat([].slice.call(arguments)))}});' +
    'p._i.push([a,b,c])};p.__SV=1;p.init(k,o)})' +
    `(window,document,${scriptJson(ph.key)},${scriptJson(options)},${scriptJson(`${ph.assetsOrigin}/static/array.js`)});</script>`
  )
}

export function notFoundPage(nonce: string): string {
  return layout({
    title: 'ページが見つかりません',
    nonce,
    body: '<main><h1>ページが見つかりません</h1><p>URL をご確認ください。公開が終了した可能性があります。</p></main>',
  })
}

export function thanksPage(nonce: string, slug: string, name: string): string {
  const n = name.trim() ? `<p>${escapeHtml([...name.trim()].slice(0, 40).join(''))} 様</p>` : ''
  return layout({
    title: '送信しました',
    nonce,
    body:
      `<main><h1>送信しました</h1>${n}<p>ご関心をお寄せいただきありがとうございます。担当者からメールでご連絡します。</p>` +
      `<p><a href="/p/${slug}">元のページに戻る</a></p></main>`,
  })
}

export function messagePage(nonce: string, title: string, message: string | string[], backSlug?: string): string {
  const back = backSlug ? `<p><a href="/p/${backSlug}#interest">入力に戻る</a></p>` : ''
  const text = Array.isArray(message)
    ? `<ul>${message.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`
    : `<p>${escapeHtml(message)}</p>`
  return layout({
    title,
    nonce,
    body: `<main><h1>${escapeHtml(title)}</h1>${text}${back}</main>`,
  })
}
