/**
 * ビジネス・ビジネスリサーチの画面の文言（英語。キーの正本）。src/shared/i18n/en.ts が `...researchEn` で取り込む。
 * 日本語は messages.ja.ts（同じキーをすべて持つ。欠けは型エラー）
 */
import { researchMainEn } from './messages/main.en'
import { researchUiEn } from './messages/ui.en'

export const researchEn = {
  'centerTabs.business': 'Business',
  'research.mode.label': 'Business research',
  'research.mode.title': 'Find businesses worth building. Promising candidates become projects in an orchestra',
  'research.mode.folders': 'Research folders',
  'research.mode.closeFile': 'Close {{name}}',
  'research.mode.emptyTitle': 'Start business research',
  'research.mode.pickTitle': 'Choose a research folder',
  'research.sidebar.add': 'Add research folder',
  'research.sidebar.empty': 'Find businesses worth building: start from existing spending, then verify customers and channels.',
  'research.sidebar.addDialogTitle': 'Choose a folder for business research',
  'business.next.label': 'Next',
  'business.next.develop': 'Develop',
  'business.next.developHint': 'Start Claude Code in a new terminal for this business and build it',
  'business.next.publish': 'Publish',
  'business.next.publishHint': 'Draft posts for X or your blog about this business',
  ...researchUiEn,
  ...researchMainEn
} as const
