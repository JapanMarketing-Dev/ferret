/**
 * 取り込みの列名: 正規化（大文字小文字・空白・全角・通貨の括弧）、見出しの行さがし（表題・# の注記のあと）、noHeader / missingColumn、合計の印
 */
import { describe, expect, it } from 'vitest'
import { findHeader, headerCurrency, isTotalLabel, matchColumns, normalizeHeader } from '../../src/shared/venture/import/columns'
import type { HeaderSpec } from '../../src/shared/venture/import/columns'
import { parseCsv } from '../../src/shared/venture/import/csv'
import { SOURCE_SPECS } from '../../src/shared/venture/import/sources'

describe('normalizeHeader', () => {
  it.each([
    ['Clicks', 'clicks'],
    ['  CLICKS  ', 'clicks'],
    ['Impr.', 'impr.'],
    ['Amount spent (JPY)', 'amountspent'],
    ['Amount spent (usd)', 'amountspent'],
    ['費用 (JPY)', '費用'],
    ['費用（JPY）', '費用'],
    ['費用 (円)', '費用'],
    ['セッションのデフォルト チャネル グループ', 'セッションのデフォルトチャネルグループ'],
    ['セッションのデフォルト　チャネル　グループ', 'セッションのデフォルトチャネルグループ'],
    ['ＣＬＩＣＫＳ', 'clicks'],
    ['﻿Date', 'date'],
    ['Created date (UTC)', 'createddate(utc)'],
    ['URL  clicks', 'urlclicks'],
    ['Cost (JPY) extra', 'cost(jpy)extra']
  ])('%j → %j', (raw, expected) => {
    expect(normalizeHeader(raw)).toBe(expected)
  })
})

describe('headerCurrency', () => {
  it('括弧の通貨', () => {
    expect(headerCurrency('Amount spent (JPY)')).toBe('JPY')
    expect(headerCurrency('Amount spent (usd)')).toBe('USD')
    expect(headerCurrency('消化金額（JPY）')).toBe('JPY')
    expect(headerCurrency('費用 (円)')).toBe('JPY')
  })
  it('通貨でない括弧・括弧なしは null', () => {
    expect(headerCurrency('Created date (UTC)')).toBeNull()
    expect(headerCurrency('Time (JST)')).toBeNull()
    expect(headerCurrency('Cost')).toBeNull()
    expect(headerCurrency('Cost (JPYEN)')).toBeNull()
  })
})

describe('matchColumns', () => {
  const columns = { date: ['day', 'date', '日'], spend: ['cost', '費用'], clicks: ['clicks'] }
  it('候補の順に最初の列', () => {
    expect(matchColumns(['Date', 'Day', 'Cost'], columns)).toEqual({ date: 1, spend: 2 })
  })
  it('日本語の列名', () => {
    expect(matchColumns(['日', '費用（JPY）'], columns)).toEqual({ date: 0, spend: 1 })
  })
  it('同じ列名が2つあれば最初の列', () => {
    expect(matchColumns(['Clicks', 'Clicks'], columns)).toEqual({ clicks: 0 })
  })
  it('合わない列は入らない', () => {
    expect(matchColumns(['foo', 'bar'], columns)).toEqual({})
  })
})

const spec: HeaderSpec = { columns: { date: ['day', 'date'], clicks: ['clicks'], spend: ['cost'], campaign: ['campaign'] }, date: 'date', needAny: ['clicks', 'spend'] }

describe('findHeader', () => {
  it('1行目が見出し', () => {
    const r = findHeader(parseCsv('Day,Clicks\n2026-10-01,1').rows, spec)
    expect(r).toMatchObject({ ok: true, index: 0, line: 1, columns: { date: 0, clicks: 1 } })
  })
  it('Google 広告の表題と期間の2行のあと', () => {
    const r = findHeader(parseCsv('Campaign report\n"October 1, 2026 - October 31, 2026"\nDay,Campaign,Cost\n2026-10-01,A,1').rows, spec)
    expect(r).toMatchObject({ ok: true, index: 2, line: 3 })
  })
  it('GA4 の # の注記のあと（空行も飛ばす）', () => {
    const r = findHeader(parseCsv('# ----\n# Date,Clicks\n\nDate,Clicks\n20261001,5').rows, spec)
    expect(r).toMatchObject({ ok: true, index: 3, line: 4 })
  })
  it('元の列名と括弧の通貨を返す', () => {
    const r = findHeader(parseCsv('Day,Cost (USD)\n2026-10-01,1').rows, spec)
    expect(r.ok && r.names).toEqual({ date: 'Day', spend: 'Cost (USD)' })
    expect(r.ok && r.currencies).toEqual({ spend: 'USD' })
  })
  it('日付の列が無ければ missingColumn（足りない列の鍵）', () => {
    const r = findHeader(parseCsv('Campaign,Clicks\nA,1').rows, spec)
    expect(r).toEqual({ ok: false, code: 'missingColumn', line: 1, detail: 'date' })
  })
  it('数の列が1つも無ければ missingColumn', () => {
    const r = findHeader(parseCsv('Day,Campaign\n2026-10-01,A').rows, spec)
    expect(r).toEqual({ ok: false, code: 'missingColumn', line: 1, detail: 'clicks|spend' })
  })
  it('一番多く合った行で足りない列を出す', () => {
    const r = findHeader(parseCsv('Campaign\nfoo\nCampaign,Clicks').rows, spec)
    expect(r).toMatchObject({ ok: false, code: 'missingColumn', line: 3 })
  })
  it('1つも合わなければ noHeader', () => {
    expect(findHeader(parseCsv('foo,bar\n1,2').rows, spec)).toEqual({ ok: false, code: 'noHeader', line: null })
  })
  it('空の表は noHeader', () => {
    expect(findHeader([], spec)).toEqual({ ok: false, code: 'noHeader', line: null })
  })
  it('見出しは先頭の 50 行までしか探さない', () => {
    const text = `${Array.from({ length: 50 }, (_, i) => `note ${i}`).join('\n')}\nDay,Clicks\n2026-10-01,1`
    expect(findHeader(parseCsv(text).rows, spec).ok).toBe(false)
    const text49 = `${Array.from({ length: 49 }, (_, i) => `note ${i}`).join('\n')}\nDay,Clicks\n2026-10-01,1`
    expect(findHeader(parseCsv(text49).rows, spec).ok).toBe(true)
  })
  it('required の列（canonical の channel）が無ければ missingColumn', () => {
    const r = findHeader(parseCsv('date,clicks\n2026-10-01,1').rows, SOURCE_SPECS.canonical.header)
    expect(r).toMatchObject({ ok: false, code: 'missingColumn', detail: 'channel' })
  })
  it('needAny が空なら日付だけで見出し（サポート）', () => {
    expect(findHeader(parseCsv('受付日,名前\n2026-10-01,山田').rows, SOURCE_SPECS.support.header).ok).toBe(true)
  })
})

describe('元ごとの列名（日英）', () => {
  const header = (source: keyof typeof SOURCE_SPECS, line: string) => findHeader(parseCsv(`${line}\n`).rows, SOURCE_SPECS[source].header)
  it('Google 広告（英語）', () => {
    expect(header('google-ads', 'Day,Campaign,Currency code,Impr.,Clicks,Cost,Conversions')).toMatchObject({
      ok: true,
      columns: { date: 0, campaign: 1, currency: 2, impressions: 3, clicks: 4, spend: 5, conversions: 6 }
    })
  })
  it('Google 広告（日本語）', () => {
    expect(header('google-ads', '日,キャンペーン,通貨コード,表示回数,クリック数,費用,コンバージョン')).toMatchObject({
      ok: true,
      columns: { date: 0, campaign: 1, currency: 2, impressions: 3, clicks: 4, spend: 5, conversions: 6 }
    })
  })
  it('Meta（英語。通貨は括弧）', () => {
    const r = header('meta-ads', 'Reporting starts,Reporting ends,Campaign name,Impressions,Link clicks,Amount spent (JPY),Leads')
    expect(r).toMatchObject({ ok: true, columns: { date: 0, campaign: 2, impressions: 3, clicks: 4, spend: 5, leads: 6 }, currencies: { spend: 'JPY' } })
  })
  it('Meta（日本語）', () => {
    expect(header('meta-ads', 'レポート開始日,キャンペーン名,インプレッション,リンクのクリック,消化金額 (JPY),リード')).toMatchObject({ ok: true })
  })
  it('GA4（英語・日本語）', () => {
    expect(header('ga4', 'Date,Session default channel group,Sessions,Key events')).toMatchObject({ ok: true, columns: { channelGroup: 1, sessions: 2, conversions: 3 } })
    expect(header('ga4', '日付,セッションのデフォルト チャネル グループ,セッション,キーイベント')).toMatchObject({ ok: true, columns: { channelGroup: 1 } })
  })
  it('Search Console', () => {
    expect(header('search-console', 'Date,Clicks,Impressions,CTR,Position')).toMatchObject({ ok: true })
    expect(header('search-console', '日付,クリック数,表示回数,CTR,掲載順位')).toMatchObject({ ok: true })
  })
  it('X', () => {
    expect(header('x', 'Date,Impressions,Likes,URL clicks,New follows')).toMatchObject({ ok: true, columns: { impressions: 1, clicks: 3, followers: 4 } })
    expect(header('x', '日付,インプレッション,リンクのクリック数,新しいフォロー')).toMatchObject({ ok: true })
  })
  it('YouTube', () => {
    expect(header('youtube', 'Date,Views,Impressions,Subscribers')).toMatchObject({ ok: true, columns: { views: 1, impressions: 2, followers: 3 } })
    expect(header('youtube', '日付,視聴回数,インプレッション数,チャンネル登録者')).toMatchObject({ ok: true })
  })
  it('TikTok', () => {
    expect(header('tiktok', 'Date,Video views,Profile views,Likes,New followers')).toMatchObject({ ok: true, columns: { videoViews: 1, profileViews: 2, followers: 4 } })
    expect(header('tiktok', '日付,動画視聴数,プロフィール表示回数,新しいフォロワー')).toMatchObject({ ok: true })
  })
  it('サポート（メール・名前の列は対応に入れない）', () => {
    const r = header('support', '受付日,経路,種類,名前,メール')
    expect(r.ok && r.columns).toEqual({ date: 0, channel: 1, type: 2 })
  })
  it('Stripe', () => {
    const r = header('stripe', 'id,Created date (UTC),Amount,Amount Refunded,Currency,Status,Customer ID,Customer Email')
    expect(r.ok && r.columns).toEqual({ id: 0, date: 1, amount: 2, refunded: 3, currency: 4, status: 5, customerId: 6, customerEmail: 7 })
  })
  it('Stripe は Amount が無ければ missingColumn', () => {
    expect(header('stripe', 'id,Created date (UTC),Status')).toMatchObject({ ok: false, code: 'missingColumn', detail: 'amount' })
  })
  it('canonical の CSV は数の種類の名前', () => {
    expect(header('canonical', 'date,channel,campaign,paymentId,impressions,revenue')).toMatchObject({ ok: true, columns: { paymentId: 3, impressions: 4, revenue: 5 } })
  })
})

describe('isTotalLabel', () => {
  it.each(['Total', 'TOTAL', 'Totals', 'Total: Account', 'Total: Campaigns', 'Grand total', '合計', '総計', '合計：アカウント', ' 合計 '])('%j は合計', (s) => {
    expect(isTotalLabel(s)).toBe(true)
  })
  it.each(['Total Recall', 'Brand', '', 'subtotal', '2026-10-01'])('%j は合計でない', (s) => {
    expect(isTotalLabel(s)).toBe(false)
  })
})
