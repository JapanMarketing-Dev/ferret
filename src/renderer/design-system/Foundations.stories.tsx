import type { Meta, StoryObj } from '@storybook/react-vite'

/**
 * トークンの一覧。正本は src/renderer/styles/tokens.css。画面の CSS は var(--…) だけを使い、生の色や px を書かない。
 * ツールバーのテーマでダーク（既定）とライトを切り替えて確かめる。
 */

const COLORS: Record<string, string[]> = {
  '面（奥から手前）': ['--color-bg-app', '--color-bg-chrome', '--color-bg-sidebar', '--color-bg-panel', '--color-bg-elevated', '--color-bg-terminal'],
  '面の状態': ['--color-surface-hover', '--color-surface-active', '--color-surface-selected'],
  '文字': ['--color-text', '--color-text-muted', '--color-text-faint', '--color-text-inverse'],
  '線': ['--color-border', '--color-border-strong', '--color-divider', '--color-divider-strong', '--color-border-focus'],
  '主ボタン・アクセント（青1色）': ['--color-primary', '--color-primary-fg', '--color-accent', '--color-accent-hover', '--color-accent-quiet', '--color-accent-wash', '--color-accent-line'],
  '意味色': ['--color-success', '--color-success-quiet', '--color-warning', '--color-warning-quiet', '--color-danger', '--color-danger-quiet'],
  '録画（赤はここだけ）': ['--color-record', '--color-record-hover', '--color-record-quiet'],
  'Agent の状態': ['--agent-working', '--agent-blocked', '--agent-done', '--agent-idle', '--agent-unknown']
}

const FONT_SIZES = ['--font-size-2xs', '--font-size-xs', '--font-size-sm', '--font-size-md', '--font-size-lg', '--font-size-xl', '--font-size-2xl', '--font-size-3xl']
const WEIGHTS = ['--font-weight-regular', '--font-weight-medium', '--font-weight-bold']
const SPACES = ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-7', '--space-8', '--space-9']
const RADII = ['--radius-sm', '--radius-md', '--radius-xl', '--radius-pill']
const SHADOWS = ['--shadow-sm', '--shadow-md', '--shadow-lg']
const SIZES = ['--size-control-sm', '--size-control', '--size-row', '--size-tabbar', '--size-titlebar', '--size-toolbar', '--size-statusbar']
const MOTION = ['--motion-instant', '--motion-fast', '--motion-normal', '--motion-slow', '--motion-exit']
const Z = ['--z-splitter', '--z-toolbar', '--z-overlay', '--z-tooltip', '--z-toast']

function value(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function Colors() {
  return (
    <div className="dss-stack">
      {Object.entries(COLORS).map(([group, names]) => (
        <section key={group} className="dss-stack">
          <h3 className="card__title">{group}</h3>
          <div className="dss-swatches">
            {names.map((name) => (
              <div key={name} className="dss-swatch" title={value(name)}>
                <span className="dss-swatch__chip" style={{ background: `var(${name})` }} />
                <span className="dss-swatch__name">{name}</span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function Typography() {
  return (
    <div className="dss-stack">
      <div className="dss-scale">
        {FONT_SIZES.map((name) => (
          <div key={name} style={{ display: 'contents' }}>
            <span className="dss-scale__name">{name} · {value(name)}</span>
            <span style={{ fontSize: `var(${name})` }}>録画して話すだけで、指摘が並ぶ</span>
          </div>
        ))}
        {WEIGHTS.map((name) => (
          <div key={name} style={{ display: 'contents' }}>
            <span className="dss-scale__name">{name} · {value(name)}</span>
            <span style={{ fontWeight: `var(${name})` as unknown as number }}>Ferret 指摘 Feedback</span>
          </div>
        ))}
        <span className="dss-scale__name">--font-mono</span>
        <code style={{ fontFamily: 'var(--font-mono)' }}>pnpm run storybook --ci</code>
      </div>
    </div>
  )
}

function Scale({ names, render }: { names: string[]; render: (name: string) => React.ReactNode }) {
  return (
    <div className="dss-scale">
      {names.map((name) => (
        <div key={name} style={{ display: 'contents' }}>
          <span className="dss-scale__name">{name} · {value(name)}</span>
          {render(name)}
        </div>
      ))}
    </div>
  )
}

const meta: Meta = {
  title: 'Foundations/トークン',
  parameters: { docs: { description: { component: 'tokens.css の全トークン。グラデーション・光彩は使わない。面はグレー、線は 1px、アクセントは青1色、赤は録画だけ。' } } }
}
export default meta
type Story = StoryObj

export const 色: Story = { render: () => <Colors /> }
export const 文字: Story = { render: () => <Typography /> }
export const 余白: Story = { render: () => <Scale names={SPACES} render={(n) => <span className="dss-bar" style={{ width: `var(${n})` }} />} /> }
export const 角丸: Story = { render: () => <Scale names={RADII} render={(n) => <span className="dss-box" style={{ borderRadius: `var(${n})` }} />} /> }
export const 影: Story = { render: () => <Scale names={SHADOWS} render={(n) => <span className="dss-box" style={{ boxShadow: `var(${n})` }} />} /> }
export const 寸法: Story = { render: () => <Scale names={SIZES} render={(n) => <span className="dss-bar" style={{ width: `calc(var(${n}) * 4)`, height: `var(${n})` }} />} /> }
export const 動き: Story = { render: () => <Scale names={MOTION} render={() => <span className="dss-label">transform / opacity だけを動かす。ease は --ease-out</span>} /> }
export const 重なり: Story = { render: () => <Scale names={Z} render={() => <span className="dss-label">数字が大きいほど手前</span>} /> }
