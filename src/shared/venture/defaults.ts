/**
 * 新しいビジネスの既定の設定・ガードレール・空の記録（docs/venture.md 2章）。
 */
import { DEFAULT_LTV_MONTHS, type CheckCategory, type GuardrailsFile, type StreamRecords, type VentureConfig } from './model'

/** venture.json の既定（通貨 JPY・メンバーなし・採算の仮定は未入力） */
export function defaultVentureConfig(name: string, createdAt: string): VentureConfig {
  return {
    version: 1,
    name,
    createdAt,
    currency: 'JPY',
    members: [],
    economics: { marginRate: null, ltvMonths: [...DEFAULT_LTV_MONTHS], monthlyRevenuePerCustomer: null }
  }
}

const CHECKS: Array<{ category: CheckCategory; ja: string; en: string }> = [
  {
    category: 'quality',
    ja: '事実と推論を分け、数字・実績・比較には出典か元のデータがある',
    en: 'Facts and inferences are kept apart, and every number, result or comparison has a source or the underlying data'
  },
  {
    category: 'quality',
    ja: '誤字・リンク切れ・古い価格や日付がない。リンク先のページが開ける',
    en: 'No typos, broken links, or outdated prices and dates. Linked pages open'
  },
  {
    category: 'terms',
    ja: '出す先（各広告・SNS・ブログの場）の規約・広告ポリシーに沿っている（禁止の商材・表現・ターゲティング）',
    en: "It follows the terms and ad policies of where it goes (each ad network, social network or blog platform): prohibited products, wording and targeting"
  },
  {
    category: 'terms',
    ja: '景品表示法: 「最安」「No.1」「必ず」など根拠のない優良・有利の表示がない。期間限定・割引は事実どおり',
    en: 'Advertising law (e.g. Japan Act against Unjustifiable Premiums and Misleading Representations): no unsupported claims such as "cheapest", "No.1" or "guaranteed"; limited-time offers and discounts are true'
  },
  {
    category: 'terms',
    ja: '薬機法・医療・健康・金融の表現: 効能効果・治る・儲かるなどの断定や保証をしていない',
    en: 'Health, medical and financial wording (e.g. Japan PMD Act): no definite claims or guarantees of effects, cures or returns'
  },
  {
    category: 'terms',
    ja: 'ステルスマーケティングにならない: 広告・PR・提供は分かるように表示している',
    en: 'No stealth marketing: ads, sponsorships and gifted items are clearly disclosed'
  },
  {
    category: 'terms',
    ja: '画像・動画・文章・音楽の権利を確かめた（生成した画像も商用利用の条件を確認。他社の商標・人物を勝手に使わない）',
    en: "Rights to images, video, text and music are confirmed (including commercial-use terms for generated images; no unauthorized use of others' trademarks or people)"
  },
  {
    category: 'brand',
    ja: 'ブランドの言葉づかい・トーン・名前の表記がそろっている。競合や顧客を貶めていない',
    en: 'Wording, tone and name spelling follow the brand. It does not disparage competitors or customers'
  },
  {
    category: 'brand',
    ja: '約束できないこと（納期・成果・サポートの範囲）を書いていない。価格と条件が今の提供と合っている',
    en: 'It promises nothing we cannot deliver (timelines, results, support scope). Prices and conditions match the current offer'
  },
  {
    category: 'privacy',
    ja: '顧客の実名・メールアドレス・電話番号・住所を記録・下書き・投稿に出していない（仮名か id を使う）',
    en: "No customer's real name, email address, phone number or address appears in records, drafts or posts (use a pseudonym or an id)"
  },
  {
    category: 'privacy',
    ja: '顧客の声・事例を出すときは本人の同意を得ている。スクリーンショットに個人の情報が写っていない',
    en: 'Customer quotes and case studies are published only with consent. Screenshots show no personal information'
  },
  {
    category: 'privacy',
    ja: 'API キー・パスワード・管理画面の URL・社外秘の数字を記録や投稿に書いていない',
    en: 'No API keys, passwords, admin URLs or confidential figures appear in records or posts'
  }
]

/** guardrails.json の既定（予算の上限の案なし・チェック項目 C01〜） */
export function defaultGuardrails(locale: 'ja' | 'en'): GuardrailsFile {
  return {
    version: 1,
    budgets: [],
    checks: CHECKS.map((c, i) => ({ id: `C${String(i + 1).padStart(2, '0')}`, category: c.category, text: locale === 'en' ? c.en : c.ja }))
  }
}

/** 業務ごとの空の記録 */
export function emptyStreams(): StreamRecords {
  return { ads: [], content: [], images: [], support: [], satisfaction: [], checks: [] }
}
