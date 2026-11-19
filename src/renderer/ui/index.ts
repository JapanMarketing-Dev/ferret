/**
 * 共通部品の入口。
 *
 * 画面を作るときは、まずここにある部品で組む。足りなければここへ足す
 * （画面ごとに独自のボタンや行を作らない。見た目がばらけ、トークンの変更が効かなくなる）。
 * 全部品の見た目と状態は Storybook（`pnpm storybook`、Ferret のデザインシステムのタブ）で状態ごとに見られる。
 * stories は src/renderer/design-system/。部品を足したら story も足す（test/unit/design-system-stories.test.ts が見る）。
 *
 * 守ること:
 *   - 色・寸法・時間は tokens.css の var(--…) だけを使う
 *   - グラデーション・光彩は使わない。面はグレー、線は 1px
 *   - アクセントは青1色（選択・進行・リンク）。赤は録画のためだけに使う
 *   - lucide のアイコンは 14〜16px（線の太さは ui.css の .lucide でそろえる）
 *   - 動かすのは transform / opacity だけ
 */

export { Badge, CountBadge, type BadgeTone } from './Badge'
export { Button, IconButton, type ButtonProps, type ButtonVariant } from './Button'
export { EmptyState } from './EmptyState'
export { ErrorBoundary } from './ErrorBoundary'
export { Field } from './Field'
export { IconTile, type IconTileTone } from './IconTile'
export { LocaleSelect } from './LocaleSelect'
export { Logo } from './Logo'
export { Progress, RecordDot, Skeleton, Spinner, Stagger } from './Progress'
export { RecordButton } from './RecordButton'
export { Card, Row } from './Row'
export { Segmented, type SegmentedOption } from './Segmented'
export { StepsArt } from './StepsArt'
export { SttLanguageSelect } from './SttLanguageSelect'
export { ThemeSegmented, ThemeToggle } from './ThemeToggle'
export { ToastProvider, setToastNoticeFallback, useToast, type ToastOptions, type ToastTone } from './Toast'
export { Tooltip } from './Tooltip'

export { Modal } from './Modal'
