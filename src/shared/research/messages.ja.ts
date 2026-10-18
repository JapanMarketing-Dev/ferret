import type { researchEn } from './messages.en'
import { researchMainJa } from './messages/main.ja'
import { researchUiJa } from './messages/ui.ja'

/** ビジネス・ビジネスリサーチの画面の文言（日本語）。src/shared/i18n/ja.ts が `...researchJa` で取り込む */
export const researchJa: Record<keyof typeof researchEn, string> = {
  'centerTabs.business': 'ビジネス',
  'research.mode.label': 'ビジネスリサーチ',
  'research.mode.title': '作る価値のある事業を探します。見込みのある候補は、オーケストラのプロジェクトになります',
  'research.mode.folders': 'リサーチのフォルダ',
  'research.mode.closeFile': '{{name}} を閉じる',
  'research.mode.emptyTitle': 'ビジネスリサーチを始める',
  'research.mode.pickTitle': 'リサーチのフォルダを選ぶ',
  'research.sidebar.add': 'リサーチのフォルダを追加',
  'research.sidebar.empty': '作る価値のある事業を探します。既存の支出から始め、顧客と集客経路を確かめます。',
  'research.sidebar.addDialogTitle': 'ビジネスリサーチのフォルダを選ぶ',
  'business.next.label': '次へ',
  'business.next.develop': '開発',
  'business.next.developHint': 'このビジネスのフォルダで新しいターミナルに Claude Code を起動して作り始めます',
  'business.next.publish': '発信',
  'business.next.publishHint': 'このビジネスについて X・ブログの投稿の下書きを作ります',
  ...researchUiJa,
  ...researchMainJa
}
