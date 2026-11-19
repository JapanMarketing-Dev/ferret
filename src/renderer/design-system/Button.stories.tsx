import type { Meta, StoryObj } from '@storybook/react-vite'
import { Download, Plus, Settings, Trash2, X } from 'lucide-react'
import { Button, IconButton, Tooltip } from '../ui'

const meta: Meta<typeof Button> = {
  title: 'Components/Button',
  component: Button,
  args: { children: '保存', variant: 'default', busy: false, disabled: false },
  argTypes: { variant: { control: 'inline-radio', options: ['primary', 'default', 'ghost', 'danger', 'record'] } },
  parameters: {
    docs: {
      description: {
        component: [
          '1画面に primary は1つだけ（次の一手が一目で分かる）。',
          '文字は動詞1〜2語（「保存」「作る」）。説明はボタンの外にも書かない。',
          '押して何も起きないボタンを置かない。処理中は busy、押せないときは disabled。',
          '取り消せない操作だけ danger。赤は録画（record）以外に使わない。'
        ].join('\n\n')
      }
    }
  }
}
export default meta
type Story = StoryObj<typeof Button>

export const 通常: Story = {}
export const 主要: Story = { args: { variant: 'primary', children: '作る', icon: <Plus size={14} /> } }
export const 控えめ: Story = { args: { variant: 'ghost', children: '設定', icon: <Settings size={14} /> } }
export const 危険: Story = { args: { variant: 'danger', children: '削除', icon: <Trash2 size={14} /> } }
export const 処理中: Story = { args: { variant: 'primary', busy: true, children: '保存中' } }
export const 押せない: Story = { args: { disabled: true } }
export const 選択中: Story = { args: { selected: true, children: '表示中' } }
export const 長い文字: Story = {
  args: { children: 'とても長いラベルはボタンを広げてしまうので、動詞1〜2語に縮める' },
  parameters: { docs: { description: { story: '長いラベルは避ける見本。こうなったら文言を縮める。' } } }
}

export const 全種類: Story = {
  render: () => (
    <div className="dss-stack">
      {(['primary', 'default', 'ghost', 'danger', 'record'] as const).map((variant) => (
        <div key={variant} className="dss-row">
          <span className="dss-label" style={{ width: 64 }}>{variant}</span>
          <Button variant={variant} icon={<Download size={14} />}>書き出す</Button>
          <Button variant={variant} busy>書き出す</Button>
          <Button variant={variant} disabled>書き出す</Button>
        </div>
      ))}
    </div>
  )
}

export const スマホ幅: Story = {
  render: () => (
    <div className="dss-narrow dss-row">
      <Button variant="primary" icon={<Plus size={14} />}>作る</Button>
      <Button>キャンセル</Button>
    </div>
  )
}

export const アイコンだけ: StoryObj<typeof IconButton> = {
  render: () => (
    <div className="dss-row">
      <Tooltip label="閉じる"><IconButton label="閉じる" icon={<X size={14} />} /></Tooltip>
      <IconButton label="設定" icon={<Settings size={14} />} variant="default" />
      <IconButton label="設定（小）" icon={<Settings size={14} />} size="sm" />
      <IconButton label="選択中" icon={<Settings size={14} />} selected />
      <IconButton label="処理中" icon={<Settings size={14} />} busy />
      <IconButton label="押せない" icon={<Settings size={14} />} disabled />
    </div>
  ),
  parameters: { docs: { description: { story: 'label は必須（読み上げと title になる）。意味が伝わりにくいアイコンは Tooltip で包む。' } } }
}
