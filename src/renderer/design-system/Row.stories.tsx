import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { FileVideo, MoreHorizontal } from 'lucide-react'
import { Badge, Button, Card, IconButton, IconTile, Row, Skeleton, Stagger } from '../ui'

const meta: Meta<typeof Row> = {
  title: 'Components/Row と Card',
  component: Row,
  args: { title: 'ログイン画面のボタンの位置', meta: '10:24', description: '右に寄せて、送信ボタンと同じ高さにそろえる' },
  decorators: [(Story) => <div style={{ maxWidth: 480 }}><Story /></div>],
  parameters: {
    docs: {
      description: {
        component: [
          '題名は1行。説明は最大2行で切れる（長文は詳細画面へ）。',
          '行に置く操作は右端に1つまで。ほかはメニュー（…）にまとめる。',
          '選択中は左端の線だけで示し、面は塗らない。',
          'Card は節の区切り。Card の中に Card を重ねない。'
        ].join('\n\n')
      }
    }
  }
}
export default meta
type Story = StoryObj<typeof Row>

export const 通常: Story = {}
export const 選択中: Story = { args: { selected: true, onClick: () => {} } }
export const 押せる行: Story = { args: { onClick: () => {}, leading: <IconTile><FileVideo size={14} /></IconTile>, trailing: <IconButton label="メニュー" icon={<MoreHorizontal size={14} />} size="sm" /> } }
export const 長い文字: Story = {
  args: {
    title: 'とても長い題名はここで1行に収まらず、末尾が省略されることを確かめるための見本の行です',
    description: '説明は2行で切れる。説明は2行で切れる。説明は2行で切れる。説明は2行で切れる。説明は2行で切れる。説明は2行で切れる。説明は2行で切れる。説明は2行で切れる。'
  }
}

function ListDemo() {
  const [selected, setSelected] = useState(1)
  const items = ['見出しの文字を小さく', 'ボタンの色を青に', '空の画面に「作る」ボタン', '表の列幅をそろえる']
  return (
    <Stagger>
      {items.map((title, i) => (
        <Row key={title} title={title} meta={`10:${20 + i}`} selected={selected === i} onClick={() => setSelected(i)} appear trailing={i === 0 ? <Badge tone="success">直した</Badge> : undefined} />
      ))}
    </Stagger>
  )
}
export const 一覧: Story = { render: () => <ListDemo /> }

export const 読み込み中: Story = {
  render: () => (
    <div className="dss-stack" style={{ gap: 'var(--space-4)' }}>
      {[0, 1, 2].map((i) => <Skeleton key={i} height={28} />)}
    </div>
  )
}

export const カード: Story = {
  render: () => (
    <Card title="録画" actions={<Button variant="ghost">変更</Button>}>
      <Row title="マイク" meta="MacBook Pro のマイク" />
      <Row title="画面" meta="内蔵ブラウザ" />
    </Card>
  )
}
