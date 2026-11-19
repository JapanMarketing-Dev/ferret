import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { Button, Modal, Progress, RecordButton, RecordDot, Spinner, Tooltip, useToast } from '../ui'

const meta: Meta = {
  title: 'Components/知らせと進み具合',
  parameters: {
    docs: {
      description: {
        component: [
          'トーストは、人が押した操作の結果だけに使う。お知らせ・注意の帯や、操作と関係ない通知は出さない。',
          '本文は1行。原因や次の一手は detail に1行。',
          '待たせるときは Progress（進み具合が分かるなら value を渡す）。小さな処理は Spinner。',
          'Modal は人の判断が要るときだけ。閉じると元の操作の場所へ戻る。'
        ].join('\n\n')
      }
    }
  }
}
export default meta
type Story = StoryObj

function ToastDemo() {
  const toast = useToast()
  return (
    <div className="dss-row">
      <Button onClick={() => toast({ tone: 'info', message: 'リンクをコピーしました' })}>info</Button>
      <Button onClick={() => toast({ tone: 'success', message: '保存しました' })}>success</Button>
      <Button onClick={() => toast({ tone: 'warning', message: 'ターミナルが開いていません', detail: '下のパネルでターミナルを開いてください' })}>warning</Button>
      <Button onClick={() => toast({ tone: 'danger', message: '保存できませんでした', detail: 'ディスクの空きを確かめてください' })}>danger</Button>
    </div>
  )
}
export const トースト: Story = { render: () => <ToastDemo /> }

export const 進み具合: Story = {
  render: () => (
    <div className="dss-stack dss-narrow">
      <Progress value={0.35} label="書き出し 35%" />
      <Progress label="準備中" />
      <div className="dss-row"><Spinner /> <Spinner size={14} label="読み込み中" /></div>
      <div className="dss-row"><RecordDot /> <RecordDot active /> <span className="dss-label">録画中の点（ゆっくり呼吸）</span></div>
    </div>
  )
}

export const ツールチップ: Story = {
  render: () => (
    <div className="dss-row" style={{ padding: 'var(--space-8)' }}>
      <Tooltip label="録画を始める" shortcut="⌘⇧R"><Button>下に開く</Button></Tooltip>
      <Tooltip label="上に開く" side="top"><Button>上に開く</Button></Tooltip>
    </div>
  )
}

export const 録画ボタン: Story = {
  render: () => (
    <div className="dss-row">
      <RecordButton recording={false} />
      <RecordButton recording />
      <RecordButton recording={false} compact />
      <RecordButton recording compact />
      <RecordButton recording={false} disabled />
    </div>
  )
}

function ModalDemo() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>削除を確かめる</Button>
      {open && (
        <Modal label="削除の確認" className="rv-modal" onClose={() => setOpen(false)}>
          <div className="dss-stack" style={{ padding: 'var(--space-7)' }}>
            <h2 className="card__title">このレビューを削除しますか</h2>
            <div className="dss-row" style={{ justifyContent: 'flex-end' }}>
              <Button onClick={() => setOpen(false)}>やめる</Button>
              <Button variant="danger" onClick={() => setOpen(false)}>削除</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
export const モーダル: Story = { render: () => <ModalDemo /> }
