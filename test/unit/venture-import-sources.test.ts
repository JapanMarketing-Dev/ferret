/**
 * 元ごとの読み取り（parseImportFile）: 日英の実物に近い見本の CSV、合計・注記・空行、壊れた行、通貨の違い、上限、規定の形（JSON・CSV）
 */
import { describe, expect, it } from 'vitest'
import { IMPORT_LIMITS, detectSource, fileLabel, parseImportFile } from '../../src/shared/venture/import'
import { freeChannel, ga4Channel, isLeadType, pseudonymizeCustomer } from '../../src/shared/venture/import/sources'
import type { SourceKind } from '../../src/shared/venture/model'

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
const utf16le = (s: string): Uint8Array => {
  const out = new Uint8Array(2 + s.length * 2)
  out[0] = 0xff
  out[1] = 0xfe
  for (let i = 0; i < s.length; i++) {
    out[2 + i * 2] = s.charCodeAt(i) & 0xff
    out[3 + i * 2] = s.charCodeAt(i) >> 8
  }
  return out
}
const run = (source: SourceKind, text: string, currency = 'JPY', name = 'sample.csv') =>
  parseImportFile({ path: `data/imports/${source}/${name}`, source, bytes: utf8(text), currency })
const codes = (r: { issues: Array<{ code: string }> }) => r.issues.map((i) => i.code)

describe('Google 広告', () => {
  const en = [
    'Campaign report',
    'October 1, 2026 - October 31, 2026',
    'Day\tCampaign\tCurrency code\tImpr.\tClicks\tCost\tConversions',
    '2026-10-01\tBrand\tJPY\t1,234\t56\t7,890\t3.00',
    '2026-10-01\tGeneric\tJPY\t500\t10\t1,000\t0.00',
    '2026-10-02\tBrand\tJPY\t--\t0\t0\t0.00',
    'Total: Account\t\tJPY\t1,734\t66\t8,890\t3.00',
    'Total: Campaigns\t\tJPY\t1,734\t66\t8,890\t3.00'
  ].join('\r\n')

  it('UTF-16LE のタブ区切り（英語の書き出し）', () => {
    const r = parseImportFile({ path: 'data/imports/google-ads/2026-10.csv', source: 'google-ads', bytes: utf16le(en), currency: 'JPY' })
    expect(r.issues).toEqual([])
    expect(r.rows).toHaveLength(3)
    expect(r.rows[0]).toEqual({
      date: '2026-10-01',
      source: 'google-ads',
      channel: 'google-ads',
      campaign: 'Brand',
      currency: 'JPY',
      values: { impressions: 1234, clicks: 56, spend: 7890, conversions: 3 },
      file: 'imports/google-ads/2026-10.csv',
      line: 4
    })
    expect(r.rows[2].values).toEqual({ clicks: 0, spend: 0, conversions: 0 })
    // 表題・期間・見出しの前の2行と合計の2行
    expect(r.skipped).toBe(4)
  })

  it('日本語の書き出し（CSV・引用符つきの桁区切り）', () => {
    const ja = [
      'キャンペーン レポート',
      '"2026年10月1日～2026年10月31日"',
      '日,キャンペーン,通貨コード,表示回数,クリック数,費用,コンバージョン',
      '2026-10-01,ブランド,JPY,"1,234",56,"7,890",3.00',
      '2026/10/02,ブランド,JPY,800,20,"2,000",1.00',
      '合計: アカウント,,JPY,"2,034",76,"9,890",4.00'
    ].join('\n')
    const r = run('google-ads', ja)
    expect(r.issues).toEqual([])
    expect(r.rows.map((x) => [x.date, x.campaign, x.values.spend])).toEqual([
      ['2026-10-01', 'ブランド', 7890],
      ['2026-10-02', 'ブランド', 2000]
    ])
  })

  it('通貨コードがビジネスの通貨と違えば費用だけ外して数は残す', () => {
    const r = run('google-ads', 'Day,Campaign,Currency code,Clicks,Cost\n2026-10-01,US,USD,5,12.30\n2026-10-01,JP,JPY,3,400')
    expect(r.rows[0].values).toEqual({ clicks: 5 })
    expect(r.rows[0].currency).toBe('USD')
    expect(r.rows[1].values).toEqual({ clicks: 3, spend: 400 })
    expect(r.issues).toEqual([{ file: 'imports/google-ads/sample.csv', line: 2, code: 'currencyMismatch', detail: 'USD ≠ JPY' }])
  })

  it('ビジネスの通貨は大文字小文字・空白を問わない', () => {
    const r = run('google-ads', 'Day,Currency code,Cost\n2026-10-01,usd,1', ' usd ')
    expect(r.issues).toEqual([])
    expect(r.rows[0]).toMatchObject({ currency: 'USD', values: { spend: 1 } })
  })

  it('通貨の列が無ければ行に通貨を付けない', () => {
    const r = run('google-ads', 'Day,Cost\n2026-10-01,100')
    expect(r.rows[0].currency).toBeUndefined()
    expect(r.rows[0].values.spend).toBe(100)
  })

  it('読めない数は badNumber で行ごと捨てる（列名と元の値）', () => {
    const r = run('google-ads', 'Day,Clicks,Cost\n2026-10-01,abc,100\n2026-10-02,1,2')
    expect(r.rows).toHaveLength(1)
    expect(r.issues).toEqual([{ file: 'imports/google-ads/sample.csv', line: 2, code: 'badNumber', detail: 'Clicks: abc' }])
  })

  it('負の数は negative で行ごと捨てる', () => {
    const r = run('google-ads', 'Day,Clicks,Cost\n2026-10-01,1,(100)\n2026-10-02,-1,2')
    expect(r.rows).toHaveLength(0)
    expect(codes(r)).toEqual(['negative', 'negative'])
    expect(r.issues[0].detail).toBe('Cost: (100)')
  })

  it('割合の値は数として読まない（badNumber）', () => {
    expect(codes(run('google-ads', 'Day,Clicks\n2026-10-01,5%'))).toEqual(['badNumber'])
  })

  it('読めない日付は badDate', () => {
    const r = run('google-ads', 'Day,Campaign,Clicks\n2026-02-30,A,1\n10/01/2026,A,1\n,A,1')
    expect(r.issues.map((i) => [i.line, i.code, i.detail])).toEqual([
      [2, 'badDate', '2026-02-30'],
      [3, 'badDate', '10/01/2026'],
      [4, 'badDate', '(empty)']
    ])
  })

  it('元の値は 80 文字までに切る', () => {
    const long = 'x'.repeat(200)
    const r = run('google-ads', `Day,Clicks\n${long},1`)
    expect(r.issues[0].detail).toHaveLength(80)
  })

  it('キャンペーン名は 200 文字までに切る', () => {
    const r = run('google-ads', `Day,Campaign,Clicks\n2026-10-01,${'c'.repeat(300)},1`)
    expect(r.rows[0].campaign).toHaveLength(200)
  })

  it('数がすべて空の行は skipped', () => {
    const r = run('google-ads', 'Day,Clicks,Cost\n2026-10-01,,--')
    expect(r.rows).toEqual([])
    expect(r.skipped).toBe(1)
  })

  it('空行・注記の行は skipped', () => {
    const r = run('google-ads', 'Day,Clicks\n2026-10-01,1\n\n,\n注: 数は速報値です\n# comment\n2026-10-02,2')
    expect(r.rows).toHaveLength(2)
    expect(r.skipped).toBe(4)
    expect(r.issues).toEqual([])
  })

  it('日付が空で数だけの行は合計の行とみなす', () => {
    const r = run('google-ads', 'Day,Clicks,Cost\n2026-10-01,1,2\n,1,2')
    expect(r.rows).toHaveLength(1)
    expect(r.skipped).toBe(1)
    expect(r.issues).toEqual([])
  })

  it('同じ日・キャンペーンの行（端末別など）は1ファイルの中ではそのまま両方', () => {
    const r = run('google-ads', 'Day,Campaign,Device,Clicks\n2026-10-01,A,Mobile,1\n2026-10-01,A,Desktop,2')
    expect(r.rows.map((x) => x.values.clicks)).toEqual([1, 2])
  })

  it('見出しが無ければ noHeader、列が足りなければ missingColumn', () => {
    expect(run('google-ads', 'foo,bar\n1,2').issues).toEqual([{ file: 'imports/google-ads/sample.csv', line: null, code: 'noHeader' }])
    expect(run('google-ads', 'Campaign,Clicks\nA,1').issues).toEqual([{ file: 'imports/google-ads/sample.csv', line: 1, code: 'missingColumn', detail: 'date' }])
  })

  it('全角の数字・円記号', () => {
    const r = run('google-ads', '日,費用,クリック数\n２０２６－１０－０１,￥１，２３４,１２')
    expect(r.rows[0].values).toEqual({ spend: 1234, clicks: 12 })
    expect(r.rows[0].date).toBe('2026-10-01')
  })
})

describe('Meta 広告', () => {
  it('英語の書き出し（通貨は列名の括弧）', () => {
    const csv = [
      'Reporting starts,Reporting ends,Campaign name,Impressions,Link clicks,Amount spent (JPY),Leads',
      '2026-10-01,2026-10-01,秋のキャンペーン,"12,000",150,"5,000",4',
      '2026-10-02,2026-10-02,秋のキャンペーン,9000,,4500,'
    ].join('\n')
    const r = run('meta-ads', csv)
    expect(r.issues).toEqual([])
    expect(r.rows[0]).toMatchObject({ channel: 'meta-ads', campaign: '秋のキャンペーン', currency: 'JPY', values: { impressions: 12000, clicks: 150, spend: 5000, leads: 4 } })
    expect(r.rows[1].values).toEqual({ impressions: 9000, spend: 4500 })
  })
  it('日本語の書き出し', () => {
    const r = run('meta-ads', 'レポート開始日,レポート終了日,キャンペーン名,インプレッション,リンクのクリック,消化金額 (JPY),リード\n2026-10-01,2026-10-01,A,100,5,300,1')
    expect(r.rows[0].values).toEqual({ impressions: 100, clicks: 5, spend: 300, leads: 1 })
  })
  it('列名の括弧の通貨が違えば消化金額を外す', () => {
    const r = run('meta-ads', 'Day,Campaign name,Impressions,Amount spent (USD)\n2026-10-01,A,100,3.20')
    expect(r.rows[0]).toMatchObject({ currency: 'USD', values: { impressions: 100 } })
    expect(codes(r)).toEqual(['currencyMismatch'])
  })
  it('Day の列があれば Day を使う', () => {
    const r = run('meta-ads', 'Reporting starts,Day,Impressions\n2026-10-01,2026-10-05,1')
    expect(r.rows[0].date).toBe('2026-10-05')
  })
})

describe('GA4', () => {
  const ga4 = [
    '# ----------------------------------------',
    '# トラフィック獲得',
    '# Start date: 20261001',
    '# End date: 20261031',
    '# ----------------------------------------',
    '',
    'Date,Session default channel group,Sessions,Key events',
    '20261001,Organic Search,120,3',
    '20261001,Paid Search,40,2',
    '20261001,Direct,30,0',
    '20261001,Referral,5,0',
    '20261001,Email,4,1',
    '20261001,Organic Social,8,0',
    '20261001,Unassigned,2,0',
    '20261001,Organic Video,3,0',
    '',
    '# ----------------------------------------',
    'Date,Total users',
    '20261001,200'
  ].join('\n')
  it('チャネルグループを経路に当てる', () => {
    const r = run('ga4', ga4)
    expect(r.issues).toEqual([])
    expect(r.rows.map((x) => x.channel)).toEqual(['organic-search', 'google-ads', 'direct', 'referral', 'email', 'other', 'other', 'youtube'])
    expect(r.rows[0]).toMatchObject({ date: '2026-10-01', source: 'ga4', values: { sessions: 120, conversions: 3 } })
  })
  it('2つ目の表の見出しの繰り返しは飛ばす（数の列が無い行は数がすべて空で飛ばす）', () => {
    const r = run('ga4', ga4)
    expect(r.rows).toHaveLength(8)
    expect(r.issues).toEqual([])
  })
  it('日本語の書き出し（キーイベント）', () => {
    const r = run('ga4', '日付,セッションのデフォルト チャネル グループ,セッション,キーイベント\n20261002,Organic Search,10,1')
    expect(r.rows[0]).toMatchObject({ date: '2026-10-02', channel: 'organic-search', values: { sessions: 10, conversions: 1 } })
  })
  it('Conversions の列（古い書き出し）', () => {
    const r = run('ga4', 'Date,Sessions,Conversions\n20261002,10,1')
    expect(r.rows[0]).toMatchObject({ channel: 'other', values: { sessions: 10, conversions: 1 } })
  })
  it('チャネルグループの列が無ければ other', () => {
    expect(run('ga4', 'Date,Sessions\n20261002,10').rows[0].channel).toBe('other')
  })
  it('ga4Channel の対応表', () => {
    expect(ga4Channel('Organic Search')).toBe('organic-search')
    expect(ga4Channel('organic search')).toBe('organic-search')
    expect(ga4Channel('Paid Search')).toBe('google-ads')
    expect(ga4Channel('Direct')).toBe('direct')
    expect(ga4Channel('Referral')).toBe('referral')
    expect(ga4Channel('Email')).toBe('email')
    expect(ga4Channel('Paid Social')).toBe('other')
    expect(ga4Channel('Display')).toBe('other')
    expect(ga4Channel('Cross-network')).toBe('other')
    expect(ga4Channel('(other)')).toBe('other')
    expect(ga4Channel('')).toBe('other')
    expect(ga4Channel('オーガニック検索')).toBe('organic-search')
  })
})

describe('Search Console', () => {
  it('英語', () => {
    const r = run('search-console', 'Date,Clicks,Impressions,CTR,Position\n2026-10-01,12,"1,500",0.8%,12.3')
    expect(r.rows[0]).toMatchObject({ channel: 'organic-search', values: { clicks: 12, impressions: 1500 } })
    expect(r.issues).toEqual([])
  })
  it('日本語', () => {
    const r = run('search-console', '日付,クリック数,表示回数,CTR,掲載順位\n2026-10-01,3,40,7.5%,8')
    expect(r.rows[0].values).toEqual({ clicks: 3, impressions: 40 })
  })
})

describe('X', () => {
  it('英語（曜日つきの日付）', () => {
    const r = run('x', 'Date,Impressions,Likes,Engagements,URL clicks,New follows\n"Thu, Oct 1, 2026",1200,30,50,12,3\n"Fri, Oct 2, 2026",800,10,20,4,0')
    expect(r.issues).toEqual([])
    expect(r.rows[0]).toMatchObject({ date: '2026-10-01', channel: 'x', values: { impressions: 1200, clicks: 12, followers: 3 } })
    expect(r.rows[1].values.followers).toBe(0)
  })
  it('日本語', () => {
    const r = run('x', '日付,インプレッション,リンクのクリック数,新しいフォロー\n2026/10/01,"1,200",5,1')
    expect(r.rows[0].values).toEqual({ impressions: 1200, clicks: 5, followers: 1 })
  })
})

describe('YouTube', () => {
  it('英語（Total の行を飛ばす。視聴はクリックに数える）', () => {
    const r = run('youtube', 'Date,Views,Impressions,Subscribers\nTotal,300,9000,5\n2026-10-01,100,3000,2\n2026-10-02,200,6000,3')
    expect(r.skipped).toBe(1)
    expect(r.rows[0]).toMatchObject({ channel: 'youtube', values: { clicks: 100, impressions: 3000, followers: 2 } })
  })
  it('日本語', () => {
    const r = run('youtube', '日付,視聴回数,インプレッション数,チャンネル登録者\n合計,1,2,3\n"Oct 1, 2026",1,2,3')
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].date).toBe('2026-10-01')
  })
  it('登録者の純減（負の数）は受ける。行も捨てず negative も出さない', () => {
    const r = run('youtube', 'Date,Views,Subscribers\n2026-10-01,10,-1\n2026-10-02,5,(3)')
    expect(r.issues).toEqual([])
    expect(r.rows.map((x) => x.values)).toEqual([
      { clicks: 10, followers: -1 },
      { clicks: 5, followers: -3 }
    ])
  })
  it('登録者が負でも、ほかの数が負なら行ごと捨てる', () => {
    const r = run('youtube', 'Date,Views,Subscribers\n2026-10-01,-10,-1')
    expect(codes(r)).toEqual(['negative'])
    expect(r.issues[0].detail).toBe('Views: -10')
    expect(r.rows).toEqual([])
  })
})

describe('X のフォロワーの純減', () => {
  it('New follows の負の数は受ける', () => {
    const r = run('x', 'Date,Impressions,URL clicks,New follows\n2026-10-01,100,2,-4')
    expect(r.issues).toEqual([])
    expect(r.rows[0].values).toEqual({ impressions: 100, clicks: 2, followers: -4 })
  })
  it('表示が負なら行ごと捨てる', () => {
    expect(codes(run('x', 'Date,Impressions,New follows\n2026-10-01,-1,2'))).toEqual(['negative'])
  })
})

describe('TikTok', () => {
  it('英語（動画の視聴は表示、プロフィールの表示はクリック）', () => {
    const r = run('tiktok', 'Date,Video views,Profile views,Likes,Comments,Shares,New followers\n2026-10-01,5000,120,300,10,5,15')
    expect(r.rows[0]).toMatchObject({ channel: 'tiktok', values: { impressions: 5000, clicks: 120, followers: 15 } })
  })
  it('新しいフォロワーの負の数は受ける', () => {
    const r = run('tiktok', 'Date,Video views,New followers\n2026-10-01,50,-2')
    expect(r.issues).toEqual([])
    expect(r.rows[0].values).toEqual({ impressions: 50, followers: -2 })
  })
  it('年の無い日付は badDate', () => {
    expect(codes(run('tiktok', 'Date,Video views\nOctober 1,50'))).toEqual(['badDate'])
  })
  it('日本語', () => {
    const r = run('tiktok', '日付,動画視聴数,プロフィール表示回数,新しいフォロワー\n2026年10月1日,10,2,1')
    expect(r.rows[0]).toMatchObject({ date: '2026-10-01', values: { impressions: 10, clicks: 2, followers: 1 } })
  })
})

describe('サポート', () => {
  const csv = [
    '受付日,経路,種類,名前,メール,内容',
    '2026-10-01,メール,問い合わせ,山田太郎,yamada@example.com,料金について',
    '2026-10-01,X,不具合,佐藤,sato@example.com,ログインできない',
    '2026-10-02,,見積もり,,,',
    '2026-10-03,電話,使い方,,,',
    '2026-10-03,web,inquiry,,,'
  ].join('\n')
  it('1行が1件。問い合わせ・見積もりは leads、ほかは tickets', () => {
    const r = run('support', csv)
    expect(r.issues).toEqual([])
    expect(r.rows.map((x) => [x.channel, x.values])).toEqual([
      ['email', { leads: 1 }],
      ['x', { tickets: 1 }],
      ['support', { leads: 1 }],
      ['support', { tickets: 1 }],
      ['support', { leads: 1 }]
    ])
  })
  it('顧客のメール・名前は行に持たない', () => {
    const r = run('support', csv)
    const text = JSON.stringify(r)
    expect(text).not.toContain('yamada')
    expect(text).not.toContain('山田')
    expect(r.rows.every((x) => x.customer === undefined)).toBe(true)
  })
  it('英語の列名', () => {
    const r = run('support', 'Created,Channel,Type\n2026-10-01T10:00:00Z,email,lead\n2026-10-01T11:00:00Z,twitter,bug')
    expect(r.rows.map((x) => [x.date, x.channel, x.values])).toEqual([
      ['2026-10-01', 'email', { leads: 1 }],
      ['2026-10-01', 'x', { tickets: 1 }]
    ])
  })
  it('種類の列が無ければすべて tickets', () => {
    expect(run('support', 'Date\n2026-10-01\n2026-10-02').rows.map((x) => x.values)).toEqual([{ tickets: 1 }, { tickets: 1 }])
  })
  it('読めない日付は badDate', () => {
    expect(codes(run('support', '受付日,種類\n昨日,問い合わせ'))).toEqual(['badDate'])
  })
  it('isLeadType', () => {
    expect(isLeadType('お問い合わせ')).toBe(true)
    expect(isLeadType('Inquiry')).toBe(true)
    expect(isLeadType('見積もり')).toBe(true)
    expect(isLeadType('資料請求')).toBe(true)
    expect(isLeadType('不具合')).toBe(false)
    expect(isLeadType('')).toBe(false)
  })
  it('freeChannel', () => {
    expect(freeChannel('メール')).toBe('email')
    expect(freeChannel('Twitter')).toBe('x')
    expect(freeChannel('google-ads')).toBe('google-ads')
    expect(freeChannel('紹介')).toBe('referral')
    expect(freeChannel('窓口')).toBe('support')
    expect(freeChannel('')).toBe('support')
  })
})

describe('Stripe', () => {
  const head = 'id,Created date (UTC),Amount,Amount Refunded,Currency,Status,Customer ID,Customer Email'
  it('支払い1件ずつ。revenue = Amount − Amount Refunded', () => {
    const csv = [
      head,
      'ch_1,2026-10-01 03:04:05,9800,0,jpy,Paid,cus_A,a@example.com',
      'ch_2,2026-10-01 23:59:59,"12,000",2000,jpy,Partially refunded,cus_B,',
      'ch_3,2026-10-02 00:00:00,5000,0,jpy,succeeded,,Buyer@Example.com '
    ].join('\n')
    const r = run('stripe', csv)
    expect(r.issues).toEqual([])
    expect(r.rows[0]).toEqual({
      date: '2026-10-01',
      source: 'stripe',
      channel: 'stripe',
      currency: 'JPY',
      customer: 'cus_A',
      paymentId: 'ch_1',
      values: { revenue: 9800 },
      file: 'imports/stripe/sample.csv',
      line: 2
    })
    expect(r.rows[1].values.revenue).toBe(10000)
    expect(r.rows[2].customer).toBe(pseudonymizeCustomer('buyer@example.com'))
    expect(r.rows[2].customer).toMatch(/^c_[0-9a-f]{16}$/)
    expect(JSON.stringify(r)).not.toContain('example.com')
  })
  it('失敗・取り消し・全額の返金は数えない（skipped）', () => {
    const csv = [head, 'ch_1,2026-10-01,1000,0,jpy,Failed,cus_A,', 'ch_2,2026-10-01,1000,1000,jpy,Refunded,cus_A,', 'ch_3,2026-10-01,1000,0,jpy,canceled,,', 'ch_4,2026-10-01,1000,0,jpy,Paid,,'].join('\n')
    const r = run('stripe', csv)
    expect(r.rows.map((x) => x.paymentId)).toEqual(['ch_4'])
    expect(r.skipped).toBe(3)
    expect(r.issues).toEqual([])
  })
  it('返金が金額より多くても負にしない（0 なので数えない）', () => {
    const r = run('stripe', `${head}\nch_1,2026-10-01,1000,1500,jpy,Paid,cus_A,`)
    expect(r.rows).toEqual([])
    expect(r.skipped).toBe(1)
  })
  it('Status の列が無ければ払ったとみなす', () => {
    const r = run('stripe', 'id,Created date (UTC),Amount,Currency\nch_1,2026-10-01,12.30,usd', 'USD')
    expect(r.rows[0].values).toEqual({ revenue: 12.3 })
  })
  it('小数の引き算の誤差を丸める', () => {
    const r = run('stripe', 'id,Created date (UTC),Amount,Amount Refunded,Currency\nch_1,2026-10-01,12.30,2.10,usd', 'USD')
    expect(r.rows[0].values.revenue).toBe(10.2)
  })
  it('通貨が違えば売上を外す（支払いの行は残る）', () => {
    const r = run('stripe', `${head}\nch_1,2026-10-01,10,0,usd,Paid,cus_A,`)
    expect(r.rows[0]).toMatchObject({ paymentId: 'ch_1', currency: 'USD', values: {} })
    expect(codes(r)).toEqual(['currencyMismatch'])
  })
  it('金額が読めない・空なら badNumber、負なら negative', () => {
    const r = run('stripe', `${head}\nch_1,2026-10-01,abc,0,jpy,Paid,,\nch_2,2026-10-01,,0,jpy,Paid,,\nch_3,2026-10-01,-5,0,jpy,Paid,,\nch_4,2026-10-01,5,x,jpy,Paid,,`)
    expect(codes(r)).toEqual(['badNumber', 'badNumber', 'negative', 'badNumber'])
    expect(r.rows).toEqual([])
  })
  it('作成日の UTC 表記（T と Z）', () => {
    const r = run('stripe', 'id,created,Amount\nch_1,2026-10-01T23:00:00Z,100')
    expect(r.rows[0].date).toBe('2026-10-01')
  })
  it('id が無くても行は読む（重複の判定は元・日・経路）', () => {
    const r = run('stripe', 'Created date (UTC),Amount\n2026-10-01,100')
    expect(r.rows[0].paymentId).toBeUndefined()
  })
  it('pseudonymizeCustomer は同じメールに同じ仮名、違うメールに違う仮名', () => {
    expect(pseudonymizeCustomer(' A@Example.com')).toBe(pseudonymizeCustomer('a@example.com'))
    expect(pseudonymizeCustomer('a@example.com')).not.toBe(pseudonymizeCustomer('b@example.com'))
    expect(pseudonymizeCustomer('山田@例.jp')).toMatch(/^c_[0-9a-f]{16}$/)
  })
})

describe('規定の形（canonical）', () => {
  const json = (v: unknown) => parseImportFile({ path: 'data/agent/x.json', source: 'canonical', bytes: utf8(JSON.stringify(v)), currency: 'JPY' })
  it('JSON の CanonicalFile', () => {
    const r = json({
      version: 1,
      source: 'x',
      fetchedAt: '2026-10-02T00:00:00Z',
      rows: [
        { date: '2026-10-01', channel: 'x', impressions: 1200, clicks: 30 },
        { date: '2026-10-01', channel: 'stripe', paymentId: 'ch_9', customer: 'Who@Example.com', currency: 'jpy', revenue: '9,800' }
      ]
    })
    expect(r.issues).toEqual([])
    expect(r.rows[0]).toEqual({ date: '2026-10-01', source: 'x', channel: 'x', values: { impressions: 1200, clicks: 30 }, file: 'agent/x.json', line: 1 })
    expect(r.rows[1]).toMatchObject({ paymentId: 'ch_9', currency: 'JPY', values: { revenue: 9800 }, line: 2 })
    expect(r.rows[1].customer).toBe(pseudonymizeCustomer('who@example.com'))
  })
  it('source が無い・違えば置いたフォルダの元', () => {
    expect(json({ version: 1, source: 'nope', rows: [{ date: '2026-10-01', channel: 'x', clicks: 1 }] }).rows[0].source).toBe('canonical')
    const r = parseImportFile({ path: 'data/imports/x/a.json', source: 'x', bytes: utf8(JSON.stringify({ rows: [{ date: '2026-10-01', channel: 'x', clicks: 1 }] })), currency: 'JPY' })
    expect(r.rows[0].source).toBe('x')
  })
  it('channel が CHANNELS に無ければ badChannel を出して other', () => {
    const r = json({ version: 1, source: 'canonical', rows: [{ date: '2026-10-01', channel: 'facebook', clicks: 1 }, { date: '2026-10-01', clicks: 2 }] })
    expect(r.rows.map((x) => x.channel)).toEqual(['other', 'other'])
    expect(r.issues.map((i) => [i.line, i.code, i.detail])).toEqual([
      [1, 'badChannel', 'facebook'],
      [2, 'badChannel', '(empty)']
    ])
  })
  it('壊れた JSON は badJson', () => {
    const r = parseImportFile({ path: 'data/agent/x.json', source: 'canonical', bytes: utf8('{"rows": ['), currency: 'JPY' })
    expect(codes(r)).toEqual(['badJson'])
    expect(r.issues[0].line).toBeNull()
  })
  it('rows が無い・配列でない・version が違えば badShape', () => {
    expect(codes(json({ version: 1 }))).toEqual(['badShape'])
    expect(codes(json({ version: 1, rows: {} }))).toEqual(['badShape'])
    expect(codes(json({ version: 2, rows: [] }))).toEqual(['badShape'])
    expect(codes(parseImportFile({ path: 'data/agent/x.json', source: 'canonical', bytes: utf8('[1,2]'), currency: 'JPY' }))).toEqual(['badShape'])
  })
  it('要素ごとの問題（形・日付・数・負）', () => {
    const r = json({
      version: 1,
      source: 'canonical',
      rows: [
        'x',
        { date: '2026-13-01', channel: 'x', clicks: 1 },
        { date: '2026-10-01', channel: 'x', clicks: 'many' },
        { date: '2026-10-01', channel: 'x', clicks: -1 },
        { date: '2026-10-01', channel: 'x', clicks: true },
        { date: '2026-10-01', channel: 'x', clicks: null },
        { channel: 'x', clicks: 1 },
        { date: '2026-10-01', channel: 'x', clicks: 3 }
      ]
    })
    expect(r.issues.map((i) => [i.line, i.code])).toEqual([
      [1, 'badShape'],
      [2, 'badDate'],
      [3, 'badNumber'],
      [4, 'negative'],
      [5, 'badNumber'],
      [7, 'badDate']
    ])
    expect(r.skipped).toBe(1)
    expect(r.rows.map((x) => x.line)).toEqual([8])
  })
  it('followers の負の数は受け、ほかの負の数は捨てる', () => {
    const r = json({ rows: [{ date: '2026-10-01', channel: 'youtube', followers: -5, clicks: 3 }, { date: '2026-10-02', channel: 'youtube', followers: '-2', clicks: -1 }] })
    expect(r.rows.map((x) => x.values)).toEqual([{ followers: -5, clicks: 3 }])
    expect(r.issues.map((i) => [i.line, i.code])).toEqual([[2, 'negative']])
  })
  it('数でない欄・知らない欄は無視する', () => {
    const r = json({ rows: [{ date: '2026-10-01', channel: 'blog', sessions: 5, note: 'x', bogus: 3 }] })
    expect(r.rows[0].values).toEqual({ sessions: 5 })
  })
  it('通貨が違えば金額だけ外す', () => {
    const r = json({ rows: [{ date: '2026-10-01', channel: 'google-ads', currency: 'USD', spend: 3, clicks: 1 }] })
    expect(r.rows[0].values).toEqual({ clicks: 1 })
    expect(codes(r)).toEqual(['currencyMismatch'])
  })
  it('同じ列名の CSV', () => {
    const r = run('canonical', 'date,channel,campaign,impressions,clicks,leads,contracts,revenue\n2026-10-01,blog,秋,100,5,1,1,"30,000"\n2026-10-01,linkedin,,1,,,,')
    expect(r.rows[0]).toMatchObject({ source: 'canonical', channel: 'blog', campaign: '秋', values: { impressions: 100, clicks: 5, leads: 1, contracts: 1, revenue: 30000 } })
    expect(r.rows[1].channel).toBe('other')
    expect(codes(r)).toEqual(['badChannel'])
  })
  it('CSV の channel の列が無ければ missingColumn', () => {
    expect(run('canonical', 'date,clicks\n2026-10-01,1').issues[0]).toMatchObject({ code: 'missingColumn', detail: 'channel' })
  })
  it('CSV の customer のメールは仮名にする', () => {
    const r = run('canonical', 'date,channel,customer,paymentId,revenue\n2026-10-01,stripe,a@example.com,ch_1,100')
    expect(r.rows[0].customer).toBe(pseudonymizeCustomer('a@example.com'))
    expect(r.rows[0].paymentId).toBe('ch_1')
  })
  it('拡張子が .csv でも { で始まれば JSON として読む', () => {
    const r = run('canonical', JSON.stringify({ rows: [{ date: '2026-10-01', channel: 'x', clicks: 1 }] }))
    expect(r.rows).toHaveLength(1)
  })
  it('rows の数の上限', () => {
    const rows = Array.from({ length: IMPORT_LIMITS.maxRows + 1 }, () => ({ date: '2026-10-01', channel: 'x', clicks: 1 }))
    expect(codes(json({ rows }))).toEqual(['tooManyRows'])
  })
})

describe('ファイル全体の問題', () => {
  it('空のファイルは emptyFile', () => {
    expect(codes(parseImportFile({ path: 'data/imports/x/a.csv', source: 'x', bytes: new Uint8Array(), currency: 'JPY' }))).toEqual(['emptyFile'])
    expect(codes(run('x', '  \n\n'))).toEqual(['emptyFile'])
    expect(codes(parseImportFile({ path: 'data/imports/x/a.csv', source: 'x', bytes: new Uint8Array([0xef, 0xbb, 0xbf]), currency: 'JPY' }))).toEqual(['emptyFile'])
  })
  it('20MB を超えれば tooLarge で読まない', () => {
    const r = parseImportFile({ path: 'data/imports/x/a.csv', source: 'x', bytes: new Uint8Array(IMPORT_LIMITS.maxBytes + 1), currency: 'JPY' })
    expect(r.issues).toEqual([{ file: 'imports/x/a.csv', line: null, code: 'tooLarge', detail: String(IMPORT_LIMITS.maxBytes + 1) }])
    expect(r.rows).toEqual([])
  })
  it('ちょうど 20MB は読む（tooLarge にしない）', () => {
    const bytes = new Uint8Array(IMPORT_LIMITS.maxBytes).fill(0x20)
    expect(codes(parseImportFile({ path: 'data/imports/x/a.csv', source: 'x', bytes, currency: 'JPY' }))).toEqual(['emptyFile'])
  })
  it('200,000 行を超えれば tooManyRows で読まない', () => {
    const text = `Date,Impressions\n${'2026-10-01,1\n'.repeat(IMPORT_LIMITS.maxRows)}`
    const r = run('x', text)
    expect(codes(r)).toEqual(['tooManyRows'])
    expect(r.rows).toEqual([])
  })
  it('ちょうど 200,000 行は読む', () => {
    const text = `Date,Impressions\n${'2026-10-01,1\n'.repeat(IMPORT_LIMITS.maxRows - 1)}`
    expect(run('x', text).rows).toHaveLength(IMPORT_LIMITS.maxRows - 1)
  })
  it('復号できなければ encoding', () => {
    expect(codes(parseImportFile({ path: 'data/imports/x/a.csv', source: 'x', bytes: new Uint8Array([0xff, 0xff, 0xff, 0x80, 0xa0, 0xfd]), currency: 'JPY' }))).toEqual(['encoding'])
  })
  it('知らない元は unknownSource', () => {
    expect(codes(parseImportFile({ path: 'a.csv', source: 'nope' as SourceKind, bytes: utf8('a'), currency: 'JPY' }))).toEqual(['unknownSource'])
  })
  it('Shift_JIS の日本語の CSV', () => {
    // 「日付,クリック数\n2026-10-01,5」の Shift_JIS
    const sjis = new Uint8Array([0x93, 0xfa, 0x95, 0x74, 0x2c, 0x83, 0x4e, 0x83, 0x8a, 0x83, 0x62, 0x83, 0x4e, 0x90, 0x94, 0x0a, ...utf8('2026-10-01,5')])
    const r = parseImportFile({ path: 'data/imports/search-console/a.csv', source: 'search-console', bytes: sjis, currency: 'JPY' })
    expect(r.rows[0].values).toEqual({ clicks: 5 })
  })
  it('セミコロン区切り', () => {
    expect(run('x', 'Date;Impressions\n2026-10-01;10').rows[0].values).toEqual({ impressions: 10 })
  })
})

describe('detectSource・fileLabel', () => {
  it.each([
    ['data/imports/google-ads/2026-10.csv', 'google-ads'],
    ['data/imports/meta-ads/a.csv', 'meta-ads'],
    ['data/imports/stripe/2026/10/a.csv', 'stripe'],
    ['/Users/me/biz/data/imports/ga4/a.csv', 'ga4'],
    ['C:\\biz\\data\\imports\\tiktok\\a.csv', 'tiktok'],
    ['data/agent/x.json', 'canonical'],
    ['data/agent/sub/x.json', 'canonical'],
    ['data/imports/canonical/a.csv', 'canonical']
  ])('%s → %s', (path, source) => {
    expect(detectSource(path)).toBe(source)
  })
  it.each([['data/imports/unknown/a.csv'], ['data/imports/x'], ['data/imports/a.csv'], ['data/agent'], ['imports/x/a.csv'], ['other/x.csv'], ['']])('%j → null', (path) => {
    expect(detectSource(path)).toBeNull()
  })
  it('後ろの data/ を優先', () => {
    expect(detectSource('data/imports/x/data/imports/ga4/a.csv')).toBe('ga4')
  })
  it('fileLabel は data/ からの相対パス', () => {
    expect(fileLabel('data/imports/x/a.csv')).toBe('imports/x/a.csv')
    expect(fileLabel('/abs/biz/data/agent/a.json')).toBe('agent/a.json')
    expect(fileLabel('C:\\biz\\data\\imports\\x\\a.csv')).toBe('imports/x/a.csv')
    expect(fileLabel('./a.csv')).toBe('a.csv')
  })
})
