import type { Meta, StoryObj } from '@storybook/react-vite'
import { FolderOpen } from 'lucide-react'
import { Button, EmptyState } from '../ui'

const meta: Meta<typeof EmptyState> = {
  title: 'Components/EmptyState',
  component: EmptyState,
  args: {
    title: 'プロジェクトを開く',
    description: 'フォルダを選ぶと、ここに画面が出ます',
    actions: <Button variant="primary" icon={<FolderOpen size={14} />}>開く</Button>
  },
  parameters: {
    docs: {
      description: {
        component: [
          '何も無いときは、次にやる1つの操作だけを見せる（primary のボタンは1つ）。',
          '見出しは今できる動作をそのまま書く（「◯◯がありません」で終わらせない）。',
          '説明は1行。絵・デモデータ・お知らせの帯は置かない。'
        ].join('\n\n')
      }
    }
  }
}
export default meta
type Story = StoryObj<typeof EmptyState>

export const 通常: Story = {}
export const 小さい: Story = { args: { size: 'sm' } }
export const 操作なし: Story = { args: { actions: undefined, description: undefined, title: 'レビューを選ぶと、ここに指摘が並びます' } }
export const 手がかり付き: Story = { args: { hints: <span className="dss-label">⌘⇧R で録画を始める</span> } }
export const スマホ幅: Story = { decorators: [(Story) => <div className="dss-narrow"><Story /></div>] }
