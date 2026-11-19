import type { Meta, StoryObj } from '@storybook/react-vite'
import { Globe, Search } from 'lucide-react'
import { Field, LocaleSelect, Segmented, SttLanguageSelect, ThemeSegmented, ThemeToggle } from '../ui'
import type { SttLanguageCode } from '@shared/sttLanguages'
import { useState } from 'react'

const meta: Meta<typeof Field> = {
  title: 'Components/Field',
  component: Field,
  args: { placeholder: 'URL を入力', disabled: false, invalid: false, mono: false },
  decorators: [(Story) => <div className="dss-narrow"><Story /></div>],
  parameters: {
    docs: {
      description: {
        component: [
          '人が入れた値は、あとから同じ場所で直せるようにする（表示だけの欄にしない）。',
          '見出しは画面の言葉で短く。説明の段落を欄の上に置かない（必要なら placeholder の一言）。',
          'エラーは invalid で縁を変え、直し方を一言だけ添える。'
        ].join('\n\n')
      }
    }
  }
}
export default meta
type Story = StoryObj<typeof Field>

export const 通常: Story = {}
export const アイコン付き: Story = { args: { icon: <Search size={14} />, placeholder: '指摘を探す' } }
export const 入力済み: Story = { args: { icon: <Globe size={14} />, defaultValue: 'http://localhost:6006', mono: true } }
export const エラー: Story = { args: { invalid: true, defaultValue: 'htp://', mono: true } }
export const 押せない: Story = { args: { disabled: true, defaultValue: '変更できません' } }
export const 末尾の補助: Story = { args: { trailing: <span className="dss-label">⌘K</span>, placeholder: 'ファイルを開く' } }
export const 長い文字: Story = { args: { defaultValue: 'http://localhost:6006/?path=/story/components-button--primary&globals=theme:light;locale:en', mono: true } }

function SttDemo() {
  const [value, setValue] = useState<SttLanguageCode>('auto')
  return <SttLanguageSelect ariaLabel="文字起こしの言語" value={value} onChange={setValue} />
}

function SegmentedDemo() {
  const [value, setValue] = useState<'pc' | 'phone'>('pc')
  return <Segmented ariaLabel="表示の幅" value={value} onChange={setValue} options={[{ value: 'pc', label: 'PC' }, { value: 'phone', label: 'スマホ' }]} />
}

export const 切り替えと選択: Story = {
  render: () => (
    <div className="dss-stack">
      <SegmentedDemo />
      <div className="dss-row"><ThemeSegmented /><ThemeToggle /></div>
      <LocaleSelect ariaLabel="言語" />
      <SttDemo />
    </div>
  ),
  parameters: { docs: { description: { story: '2〜3択は Segmented、それより多いときは select（st-select）。' } } }
}
