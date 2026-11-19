import type { Meta, StoryObj } from '@storybook/react-vite'
import { DesignSystem } from '../components/DesignSystem'
import { resetAdeResponses, setAdeResponse } from './adeStub'

/**
 * 画面の見本。main の返事を見本の値に差し替えて、状態ごとの見た目を確かめる（main・ネットワークにはつながない）。
 */
const meta: Meta<typeof DesignSystem> = {
  title: 'Screens/デザインシステムのタブ',
  component: DesignSystem,
  args: { folderPath: '/Users/me/project' },
  decorators: [(Story) => <div className="dss-frame"><Story /></div>],
  parameters: {
    layout: 'padded',
    docs: { description: { component: '状態ごとに次の一手は1つだけ（起動する／Agent に作ってもらう）。動いていればタブいっぱいに出す。' } }
  }
}
export default meta
type Story = StoryObj<typeof DesignSystem>

export const 止まっている: Story = {
  beforeEach: () => {
    resetAdeResponses()
    setAdeResponse('designSystem:status', { state: 'stopped', url: 'http://localhost:6006', command: 'pnpm run storybook --ci' })
  }
}

export const まだ無い: Story = {
  beforeEach: () => {
    resetAdeResponses()
    setAdeResponse('designSystem:status', { state: 'none', url: 'http://localhost:6006' })
    setAdeResponse('agent:sendText', { ok: true, message: '' })
  }
}

export const 起動コマンドが分からない: Story = {
  beforeEach: () => {
    resetAdeResponses()
    setAdeResponse('designSystem:status', { state: 'stopped', url: 'http://localhost:6006' })
  }
}

export const プロジェクト未選択: Story = { args: { folderPath: null } }

export const 読み込み中: Story = {
  beforeEach: () => {
    resetAdeResponses()
    setAdeResponse('designSystem:status', () => new Promise(() => {}) as never)
  }
}
