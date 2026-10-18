/**
 * .business/context.md（Agent が最初に読む）と .business/README.md（記録の形式）の文。
 * 長いデータは貼らず、いまのステップ・数・残りの U・次の確認・関係するファイルの場所だけを書く。
 */
import { STEPS, stepById, type BusinessData } from './model'
import { judge, moneyLabel, cac } from './experiment'
import { summarize, currentHypothesis } from './steps'
import { validateBusiness } from './rules'

export function contextMarkdown(data: BusinessData, now: string): string {
  const s = summarize(data)
  const step = stepById(s.step)
  const h = currentHypothesis(data)
  const issues = validateBusiness(data).slice(0, 20)
  const files: string[] = ['business.yaml']
  if (h) {
    files.push(`hypotheses/${h.id}.md`)
    for (const e of data.evidence.filter((x) => x.hypotheses.includes(h.id)).slice(0, 30)) files.push(`evidence/${e.id}.md`)
    for (const a of data.alternatives.filter((x) => x.hypothesis === h.id)) files.push(`alternatives/${a.id}.md`)
    for (const x of data.experiments.filter((x) => x.hypothesis === h.id)) files.push(`experiments/${x.id}.md`)
  }
  const experiments = data.experiments
    .filter((x) => !h || x.hypothesis === h.id)
    .map((x) => {
      const j = judge(x)
      return `- ${x.id}（${x.status}）${x.channel || '経路未定'}: 判定 ${j.verdict}${j.verdict === '判定できない' ? `（${j.reason}）` : ''}、CAC ${moneyLabel(cac(x.actual))}`
    })
  const pending = data.approvals.filter((a) => a.status === '待ち').map((a) => `- ${a.id} ${a.kind}: ${a.title}`)
  return [
    `# いまの状況（${data.business.name}）`,
    '',
    `更新: ${now}（Ferret が送るたびに書き直す。手で直さない）`,
    '',
    `- ステップ: ${s.step} ${step.name}（${step.phase}）／ ${s.loop} 周目`,
    `- 対象: ${data.business.target || 'U'}`,
    `- 今の仮説: ${h ? `${h.id} ${h.name || '（名前なし）'}／段階 ${h.stage}` : 'なし'}`,
    `- 需要点 D: ${s.demand} ／ 獲得点 A: ${s.acquisition} ／ U の残り: ${s.unknowns}`,
    `- 独立当事者: ${s.independentParties}`,
    `- 記録の数: 仮説 ${s.counts.hypotheses}、証拠 ${s.counts.evidence}（読了 ${s.counts.readEvidence}）、代替 ${s.counts.alternatives}、聞き取り ${s.counts.interviews}、実験 ${s.counts.experiments}`,
    `- 人の承認待ち: ${s.counts.pendingApprovals} 件`,
    '',
    '## このステップの出口条件',
    '',
    `${step.exit}（手法.md ${step.method}）`,
    '',
    ...s.checks.map((c) => `- [${c.done ? 'x' : ' '}] ${c.label}`),
    '',
    '## 次に確かめること',
    '',
    s.next || 'U（仮説ファイルの next に書く）',
    '',
    ...(experiments.length ? ['## 実験', '', ...experiments, ''] : []),
    ...(pending.length ? ['## 人の承認待ち（これらは実行しない）', '', ...pending, ''] : []),
    ...(issues.length ? ['## 記録の注意', '', ...issues.map((i) => `- ${i.severity === 'error' ? '直す' : '注意'} ${i.ref} ${i.field}: ${i.message}`), ''] : []),
    '## 関係するファイル',
    '',
    ...files.map((f) => `- ${f}`),
    '',
    '記録の形式と書いてよいファイルは .business/README.md、調べ方の原則は principles/手法.md。',
    ''
  ].join('\n')
}

/** 記録の形式（Agent 用）。新しいビジネスを作るときに書き、版が変わったら書き直す */
export const RECORD_README = `# 記録の形式（Ferret）

このフォルダはビジネス1件の記録です。人と Agent が同じファイルを読み書きします。原則は principles/手法.md。

## 置き場所

| 記録 | ファイル | ID |
|---|---|---|
| ビジネス | business.yaml | — |
| 仮説（15.3） | hypotheses/H01.md | H01… |
| 証拠（15.1） | evidence/E01.md | E01… |
| 代替比較（15.2） | alternatives/ALT01.md | ALT01… |
| 聞き取り | interviews/I01.md | I01… |
| 実験（15.4） | experiments/X01.md | X01… |
| 結論（15.5） | decisions/C01.md | C01… |
| 人の承認の依頼 | approvals/R01.md | R01… |
| 検索履歴 | searches.jsonl | — |
| Agent の提案 | .business/proposals/*.md | — |

記録は先頭の \`---\` で囲んだ YAML が正本で、その下の本文は自由なメモです。ID は2桁以上の連番で、使い回しません。

## 決まり

- 未確認は \`U\`。U を 0 として合計しない。U が1つでもあれば合計は「未完了」。
- 需要点 D（10点満点）と獲得点 A（8点満点）は足さない。P は はい／いいえ／U。
- 点数（score）には根拠の証拠 ID（evidence）を付ける。
- 独立した当事者は dupGroup（同一人物・企業のまとまり）で数える。匿名で判別できなければ dupGroup: U（数えない）。
- 原典を読めていない証拠は readStatus: 発見のみ（数えない）。
- 関心表明（interest）・見積依頼（quoteRequests）・入金（payments）・成果受入（accepted）・再購入（repurchased）は別の欄。
- 実験の plan（計画）と actual（実測）を混ぜない。status: 計画のみ の間は actual を空のまま。
- 顧客が 0 件なら CAC は「未成立」。0 円と書かない。
- 聞き取りは consent: true のときだけ原文（transcript）を書く。氏名・連絡先は書かない。

## 書いてよいファイル

- Agent が書いてよい: evidence/、alternatives/、searches.jsonl、.business/proposals/、approvals/（依頼の追加だけ。status は 待ち）、experiments/（status: 計画のみ の下書きだけ）、decisions/（下書き）。
- 人だけが変える: business.yaml の step・loop・currentHypothesis、仮説の stage・verdict、実験の status と actual、承認の status・answer。

## 人の承認が要る操作（Agent は実行しない）

応募、営業送信、外部への送信、広告出稿、課金、ログインが要るサイトの操作、実験ページの公開、段階を進める、棄却。
必要なら approvals/R??.md に kind・title・detail・refs・options（推奨を先頭、2〜4個）を書き、status: 待ち で止まる。

## ステップ

${STEPS.map((s) => `- ${s.id} ${s.name}: ${s.exit}`).join('\n')}
`
