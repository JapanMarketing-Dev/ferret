import type { ReactNode } from 'react'
import { Plus } from 'lucide-react'
import { RECORD_KINDS, type BusinessData, type RecordKind } from '@shared/business/model'
import { acquisitionTotal, countability, demandTotal, independentParties, totalLabel } from '@shared/business/scoring'
import { cac, judge, moneyLabel } from '@shared/business/experiment'
import { Badge, Button, EmptyState, Tooltip } from '../ui'
import { JudgeBadge } from './forms'
import { compactProvision, compactTotal, experimentTone, provisionText } from './view'

/** 表の1行（先頭の ID を押すと開く。行のどこを押しても開く） */
function RowLink({ id, onOpen, children, testId }: { id: string; onOpen: (id: string) => void; children: ReactNode; testId?: string }) {
  return (
    <tr className="biz-tr-link" onClick={() => onOpen(id)} data-testid={testId}>
      <td className="biz-nowrap">
        <button type="button" className="biz-link biz-mono" onClick={(e) => { e.stopPropagation(); onOpen(id) }}>{id}</button>
      </td>
      {children}
    </tr>
  )
}

function Cell({ children, title, className }: { children: ReactNode; title?: string; className?: string }) {
  return <td className={className}><span className="biz-ellipsis" title={title}>{children}</span></td>
}

/** D/A の合計。U があれば「未完了（U 残り n）」で、0 と書かない */
export function TotalCell({ total, testId }: { total: ReturnType<typeof demandTotal>; testId?: string }) {
  return (
    <td className="biz-nowrap" data-testid={testId}>
      {total.complete ? <span className="biz-num-text">{compactTotal(total)}</span> : <Tooltip label={totalLabel(total)}><Badge tone="warning">{compactTotal(total)}</Badge></Tooltip>}
    </td>
  )
}

export function HypothesisTable({ data, onOpen }: { data: BusinessData; onOpen: (id: string) => void }) {
  return (
    <table className="biz-table" data-testid="hypothesis-table">
      <thead>
        <tr>
          <th scope="col">ID</th>
          <th scope="col" className="biz-col-grow">名前</th>
          <th scope="col">段階</th>
          <th scope="col"><Tooltip label="需要（10点満点）"><span>D</span></Tooltip></th>
          <th scope="col"><Tooltip label="獲得（8点満点）"><span>A</span></Tooltip></th>
          <th scope="col"><Tooltip label="提供条件"><span>P</span></Tooltip></th>
          <th scope="col"><Tooltip label="重複を除いた独立当事者"><span>当事者</span></Tooltip></th>
          <th scope="col">判定</th>
        </tr>
      </thead>
      <tbody>
        {data.hypotheses.map((h) => (
          <RowLink key={h.id} id={h.id} onOpen={onOpen} testId={`hrow-${h.id}`}>
            <Cell title={h.name} className="biz-col-grow">{h.name || <span className="biz-muted">名前なし</span>}</Cell>
            <td className="biz-nowrap">{h.stage}</td>
            <TotalCell total={demandTotal(h)} testId={`hrow-${h.id}-d`} />
            <TotalCell total={acquisitionTotal(h)} testId={`hrow-${h.id}-a`} />
            <td className="biz-nowrap" data-testid={`hrow-${h.id}-p`} title={provisionText(h)}>{compactProvision(h)}</td>
            <td className="biz-nowrap biz-num-text">{independentParties(h.id, data.evidence)}</td>
            <td className="biz-nowrap">{h.verdict ? <Badge tone={h.verdict === '進める' ? 'success' : h.verdict === '棄却' ? 'danger' : 'neutral'}>{h.verdict}</Badge> : <span className="biz-muted">未定</span>}</td>
          </RowLink>
        ))}
      </tbody>
    </table>
  )
}

export function RecordList({ kind, data, onOpen, onNew }: { kind: Exclude<RecordKind, 'approval'>; data: BusinessData; onOpen: (id: string) => void; onNew: () => void }) {
  const label = RECORD_KINDS[kind].label
  const head = (
    <header className="biz-list__head">
      <h2 className="biz-h2">{label}</h2>
      <span className="biz-count">{countOf(kind, data)} 件</span>
      <span className="biz-spacer" />
      <Button variant="primary" icon={<Plus size={14} />} onClick={onNew} data-testid={`new-${kind}`}>追加</Button>
    </header>
  )
  if (countOf(kind, data) === 0) {
    return (
      <div className="biz-list" data-testid={`list-${kind}`}>
        {head}
        <EmptyState size="sm" title={`${label}はまだありません`} />
      </div>
    )
  }
  return (
    <div className="biz-list" data-testid={`list-${kind}`}>
      {head}
      {kind === 'hypothesis' && <HypothesisTable data={data} onOpen={onOpen} />}
      {kind === 'evidence' && (
        <table className="biz-table">
          <thead><tr><th scope="col">ID</th><th scope="col" className="biz-col-grow">当事者</th><th scope="col">媒体</th><th scope="col">根拠の性質</th><th scope="col">読めたか</th><th scope="col">仮説</th><th scope="col">数えるか</th></tr></thead>
          <tbody>
            {data.evidence.map((e) => {
              const c = countability(e)
              return (
                <RowLink key={e.id} id={e.id} onOpen={onOpen} testId={`erow-${e.id}`}>
                  <Cell title={e.party} className="biz-col-grow">{e.party || <span className="biz-muted">未記入</span>}</Cell>
                  <Cell>{e.medium}</Cell>
                  <td className="biz-nowrap">{e.sourceKind}</td>
                  <td className="biz-nowrap">{e.readStatus === '読了' ? '読了' : <Badge tone="warning">発見のみ</Badge>}</td>
                  <td className="biz-nowrap biz-mono">{e.hypotheses.join(' ')}</td>
                  <td className="biz-nowrap">{c.counts ? <Badge tone="success">数える</Badge> : <Tooltip label={c.reason}><span className="biz-muted">数えない</span></Tooltip>}</td>
                </RowLink>
              )
            })}
          </tbody>
        </table>
      )}
      {kind === 'alternative' && (
        <table className="biz-table">
          <thead><tr><th scope="col">ID</th><th scope="col">仮説</th><th scope="col">今の方法</th><th scope="col">総費用</th><th scope="col" className="biz-col-grow">残る不足</th></tr></thead>
          <tbody>
            {data.alternatives.map((a) => (
              <RowLink key={a.id} id={a.id} onOpen={onOpen}>
                <td className="biz-nowrap biz-mono">{a.hypothesis}</td>
                <Cell title={a.method}>{a.method}</Cell>
                <Cell title={a.cost}>{a.cost}</Cell>
                <Cell title={a.gap} className="biz-col-grow">{a.gap}</Cell>
              </RowLink>
            ))}
          </tbody>
        </table>
      )}
      {kind === 'interview' && (
        <table className="biz-table">
          <thead><tr><th scope="col">ID</th><th scope="col">仮説</th><th scope="col" className="biz-col-grow">相手の役割</th><th scope="col">日付</th><th scope="col">同意</th><th scope="col">証拠</th></tr></thead>
          <tbody>
            {data.interviews.map((i) => (
              <RowLink key={i.id} id={i.id} onOpen={onOpen}>
                <td className="biz-nowrap biz-mono">{i.hypothesis}</td>
                <Cell title={i.role} className="biz-col-grow">{i.role}</Cell>
                <td className="biz-nowrap">{i.date}</td>
                <td className="biz-nowrap">{i.consent ? <Badge tone="success">あり</Badge> : <Badge tone="warning">なし</Badge>}</td>
                <td className="biz-nowrap biz-num-text">{i.evidence.length}</td>
              </RowLink>
            ))}
          </tbody>
        </table>
      )}
      {kind === 'experiment' && (
        <table className="biz-table">
          <thead><tr><th scope="col">ID</th><th scope="col">仮説</th><th scope="col">状態</th><th scope="col" className="biz-col-grow">経路</th><th scope="col">価格</th><th scope="col">CAC</th><th scope="col">判定</th></tr></thead>
          <tbody>
            {data.experiments.map((x) => (
              <RowLink key={x.id} id={x.id} onOpen={onOpen} testId={`xrow-${x.id}`}>
                <td className="biz-nowrap biz-mono">{x.hypothesis}</td>
                <td className="biz-nowrap"><Badge tone={experimentTone(x.status)}>{x.status}</Badge></td>
                <Cell title={x.channel} className="biz-col-grow">{x.channel}</Cell>
                <Cell title={x.price}>{x.price}</Cell>
                <td className="biz-nowrap" data-testid={`xrow-${x.id}-cac`}>{moneyLabel(cac(x.actual))}</td>
                <td className="biz-nowrap"><JudgeBadge verdict={judge(x).verdict} /></td>
              </RowLink>
            ))}
          </tbody>
        </table>
      )}
      {kind === 'decision' && (
        <table className="biz-table">
          <thead><tr><th scope="col">ID</th><th scope="col">仮説</th><th scope="col">判定</th><th scope="col">段階</th><th scope="col">打ち手</th><th scope="col" className="biz-col-grow">学び</th></tr></thead>
          <tbody>
            {data.decisions.map((d) => (
              <RowLink key={d.id} id={d.id} onOpen={onOpen}>
                <td className="biz-nowrap biz-mono">{d.hypothesis}</td>
                <td className="biz-nowrap">{d.verdict}</td>
                <td className="biz-nowrap">{d.stage}</td>
                <td className="biz-nowrap">{d.worked}</td>
                <Cell title={d.learnings.join('\n')} className="biz-col-grow">{d.learnings[0] ?? ''}</Cell>
              </RowLink>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function countOf(kind: Exclude<RecordKind, 'approval'>, data: BusinessData): number {
  return { hypothesis: data.hypotheses, evidence: data.evidence, alternative: data.alternatives, interview: data.interviews, experiment: data.experiments, decision: data.decisions }[kind].length
}
