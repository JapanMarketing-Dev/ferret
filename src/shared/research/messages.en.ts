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
  'research.profile.button': 'About you',
  'research.profile.title': 'About you (the basis of research and business)',
  'research.profile.hint': 'Agents search for where to enter, and run the business, from what you write here. Write your experience, current business, assets, the time and money you can put in, your goal and what you will not do. It is shared by every research and business.',
  'research.profile.field': 'About you (Markdown)',
  'research.profile.save': 'Save',
  'research.profile.saved': 'Saved. It is used from the next request you send.',
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
