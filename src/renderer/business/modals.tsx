import { useState, type ReactNode } from 'react'
import { ArrowRight, FileWarning } from 'lucide-react'
import { CHANGE_AXES, STAGE_EXIT, stepById, type ChangeAxis, type Hypothesis, type Stage, type StepId, type BusinessData } from '@shared/business/model'
import { evidenceFor, independentParties, priorityCheck, sourceTypes } from '@shared/business/scoring'
import { Badge, Button, Modal } from '../ui'
import { BACK_STEPS, defaultBackStep, nextStage } from './view'

function BizModal({ label, children, testId, onClose }: { label: string; children: ReactNode; testId: string; onClose: () => void }) {
  return (
    <Modal className="biz-modal" label={label} onClose={onClose}>
      <div className="biz-modal__panel" data-testid={testId}>
        <header className="biz-modal__head"><h2>{label}</h2></header>
        {children}
      </div>
    </Modal>
  )
}

/** 段階を進める。出口の条件と証拠の要約を見て、人が確認して押す（点数では進めない） */
export function AdvanceStageModal({ hypothesis, data, onClose, onConfirm }: {
  hypothesis: Hypothesis
  data: BusinessData
  onClose: () => void
  onConfirm: (to: Stage, note: string) => Promise<boolean>
}) {
  const to = nextStage(hypothesis.stage)
  const [checked, setChecked] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const ev = evidenceFor(hypothesis.id, data.evidence)
  const priority = priorityCheck(hypothesis, data.evidence)
  const interviews = data.interviews.filter((i) => i.hypothesis === hypothesis.id && i.consent).length
  const xs = data.experiments.filter((x) => x.hypothesis === hypothesis.id)
  const payments = xs.reduce((n, x) => n + (x.actual.payments ?? 0), 0)
  const repurchased = xs.reduce((n, x) => n + (x.actual.repurchased ?? 0), 0)
  const facts: Array<[string, string]> = [
    ['証拠', `${ev.length} 件（読了 ${ev.filter((e) => e.readStatus === '読了').length}）`],
    ['独立当事者', `${independentParties(hypothesis.id, data.evidence)}`],
    ['原典の種類', `${sourceTypes(hypothesis.id, data.evidence)}`],
    ['同意つきの聞き取り', `${interviews} 件`],
    ['入金の記録', xs.some((x) => x.actual.payments !== null) ? `${payments} 件` : '未計測'],
    ['再購入の記録', xs.some((x) => x.actual.repurchased !== null) ? `${repurchased} 件` : '未計測']
  ]
  return (
    <BizModal label="段階を進める" testId="advance-modal" onClose={onClose}>
      {to === null ? (
        <p className="biz-modal__body">最後の段階です。</p>
      ) : (
        <div className="biz-modal__body">
          <div className="biz-stage-move">
            <Badge>{hypothesis.stage}</Badge>
            <ArrowRight size={14} aria-hidden="true" />
            <Badge tone="brand">{to}</Badge>
          </div>
          <dl className="biz-facts" data-testid="advance-facts">
            {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          </dl>
          {!priority.meets && (
            <ul className="biz-missing" data-testid="advance-missing">
              {priority.missing.map((m) => <li key={m}>{m}</li>)}
            </ul>
          )}
          <label className="biz-check biz-check--block">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} data-testid="advance-check" />
            <span>{STAGE_EXIT[hypothesis.stage]}</span>
          </label>
          <label className="biz-modal__label" htmlFor="advance-note">メモ</label>
          <textarea id="advance-note" className="biz-textarea" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      )}
      <footer className="biz-modal__foot">
        <Button variant="ghost" onClick={onClose}>キャンセル</Button>
        {to !== null && (
          <Button
            variant="primary"
            disabled={!checked}
            busy={busy}
            onClick={async () => { setBusy(true); const ok = await onConfirm(to, note.trim()); setBusy(false); if (ok) onClose() }}
            data-testid="advance-confirm"
          >
            {to}へ進める
          </Button>
        )}
      </footer>
    </BizModal>
  )
}

/** 周を閉じる。変えるもの1つと戻るステップを決める */
export function CloseLoopModal({ loop, onClose, onConfirm }: {
  loop: number
  onClose: () => void
  onConfirm: (input: { changed: ChangeAxis; backTo: StepId; note: string }) => Promise<boolean>
}) {
  const [axis, setAxis] = useState<ChangeAxis | null>(null)
  const [backTo, setBackTo] = useState<StepId>('S1')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <BizModal label={`${loop}周目を閉じる`} testId="loop-modal" onClose={onClose}>
      <div className="biz-modal__body">
        <fieldset className="biz-axis" data-testid="loop-axes">
          <legend className="biz-modal__label">変えるもの</legend>
          <div className="biz-axis__items">
            {CHANGE_AXES.map((a) => (
              <label key={a} className={`biz-option${axis === a ? ' is-checked' : ''}`}>
                <input type="radio" name="loop-axis" value={a} checked={axis === a} onChange={() => { setAxis(a); setBackTo(defaultBackStep(a)) }} data-testid={`loop-axis-${a}`} />
                <span>{a}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="biz-modal__label" htmlFor="loop-back">戻るステップ</label>
        <select id="loop-back" className="biz-select" value={backTo} onChange={(e) => setBackTo(e.target.value as StepId)} data-testid="loop-back">
          {BACK_STEPS.map((s) => <option key={s} value={s}>{s} {stepById(s).name}</option>)}
        </select>
        <label className="biz-modal__label" htmlFor="loop-note">メモ</label>
        <textarea id="loop-note" className="biz-textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} data-testid="loop-note" />
      </div>
      <footer className="biz-modal__foot">
        <Button variant="ghost" onClick={onClose}>キャンセル</Button>
        <Button
          variant="primary"
          disabled={axis === null}
          busy={busy}
          onClick={async () => { if (!axis) return; setBusy(true); const ok = await onConfirm({ changed: axis, backTo, note: note.trim() }); setBusy(false); if (ok) onClose() }}
          data-testid="loop-confirm"
        >
          次の周へ
        </Button>
      </footer>
    </BizModal>
  )
}

/** 保存していない記録から離れるとき */
export function UnsavedModal({ label, onChoose }: { label: string; onChoose: (choice: 'save' | 'discard' | 'cancel') => void }) {
  return (
    <Modal className="biz-modal" label="保存していない変更" onClose={() => onChoose('cancel')}>
      <div className="biz-modal__panel" data-testid="unsaved-modal">
        <header className="biz-modal__head"><h2><FileWarning size={15} aria-hidden="true" />{label} を保存しますか</h2></header>
        <footer className="biz-modal__foot">
          <Button variant="ghost" onClick={() => onChoose('discard')} data-testid="unsaved-discard">保存しない</Button>
          <span className="biz-spacer" />
          <Button variant="ghost" onClick={() => onChoose('cancel')}>キャンセル</Button>
          <Button variant="primary" autoFocus onClick={() => onChoose('save')} data-testid="unsaved-save">保存</Button>
        </footer>
      </div>
    </Modal>
  )
}
