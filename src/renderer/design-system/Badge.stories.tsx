import type { Meta, StoryObj } from '@storybook/react-vite'
import { Check } from 'lucide-react'
import { Badge, CountBadge, IconTile, Logo } from '../ui'

const meta: Meta<typeof Badge> = {
  title: 'Components/Badge',
  component: Badge,
  args: { children: '下書き', tone: 'neutral' },
  argTypes: { tone: { control: 'inline-radio', options: ['neutral', 'brand', 'success', 'warning', 'danger', 'record'] } },
  parameters: {
    docs: {
      description: {
        component: [
          '札は1〜2語。数字だけの札にしない（何の数かを言葉で添える）。',
          '状態を知らせるだけ。押させたいならボタンにする。',
          'record（赤）は録画中だけ。'
        ].join('\n\n')
      }
    }
  }
}
export default meta
type Story = StoryObj<typeof Badge>

export const 通常: Story = {}
export const 全種類: Story = {
  render: () => (
    <div className="dss-row">
      <Badge>下書き</Badge>
      <Badge tone="brand">自分</Badge>
      <Badge tone="success" icon={<Check size={12} />}>承認済み</Badge>
      <Badge tone="warning">確認待ち</Badge>
      <Badge tone="danger">失敗</Badge>
      <Badge tone="record">録画中</Badge>
    </div>
  )
}
export const 件数: Story = {
  render: () => (
    <div className="dss-row">
      <span style={{ position: 'relative', paddingRight: 'var(--space-5)' }}>指摘<CountBadge count={3} /></span>
      <span style={{ position: 'relative', paddingRight: 'var(--space-6)' }}>指摘<CountBadge count={120} /></span>
      <span className="dss-label">0 のときは出さない</span>
    </div>
  )
}
export const アイコンの札とロゴ: Story = {
  render: () => (
    <div className="dss-row">
      <IconTile size="sm"><Check size={12} /></IconTile>
      <IconTile><Check size={14} /></IconTile>
      <IconTile size="lg"><Check size={16} /></IconTile>
      <Logo size={20} />
      <Logo size={32} />
    </div>
  )
}
