/**
 * 登録したプロジェクトのうち、ビジネスのもの（サイドバーとダッシュボードの一覧）。
 * 安く・上限つきで読む: business.yaml、承認の依頼（待ちの数）、今の仮説の段階だけ。読めないプロジェクトは飛ばす
 */
import type { BusinessListItem } from '@shared/business/ipc'
import { isRecordId } from '@shared/business/model'
import { coerceBusiness, coerceRecord } from '@shared/business/records'
import { parseRecordFile, parseYaml } from '@shared/business/format'
import { BusinessFs } from './fsx'

const MAX_PROJECTS = 200
const MAX_APPROVAL_FILES = 500
const SMALL_FILE_BYTES = 64 * 1024

export interface ListedProject {
  id: string
  folderPath: string
  source?: string
}

async function readItem(project: ListedProject, now: string): Promise<BusinessListItem | null> {
  const fs = new BusinessFs(project.folderPath)
  const raw = await fs.readText('business.yaml', SMALL_FILE_BYTES)
  if (raw === null) return null
  const business = coerceBusiness(parseYaml(raw), project.folderPath.split(/[\\/]/).filter(Boolean).at(-1) ?? 'ビジネス', now).value
  let pendingApprovals = 0
  try {
    const { entries } = await fs.list('approvals', MAX_APPROVAL_FILES)
    for (const e of entries) {
      const id = e.name.replace(/\.md$/, '')
      if (e.kind !== 'file' || !e.name.endsWith('.md') || !isRecordId('approval', id)) continue
      try {
        const text = await fs.readText(`approvals/${e.name}`, SMALL_FILE_BYTES)
        if (text !== null && coerceRecord('approval', parseRecordFile(text).data, id, now).value.status === '待ち') pendingApprovals++
      } catch {
        // 壊れた依頼は数えない（開いたときの読み込みで problems に出る）
      }
    }
  } catch {
    // approvals/ がリンクなど（開いたときに出る）
  }
  let stage: BusinessListItem['stage'] = null
  if (business.currentHypothesis) {
    try {
      const text = await fs.readText(`hypotheses/${business.currentHypothesis}.md`, SMALL_FILE_BYTES)
      if (text !== null) stage = coerceRecord('hypothesis', parseRecordFile(text).data, business.currentHypothesis, now).value.stage
    } catch {
      stage = null
    }
  }
  return { projectId: project.id, name: business.name, step: business.step, loop: business.loop, stage, pendingApprovals }
}

/** SSH のプロジェクト（フォルダが手元に無い）は除く */
export async function listBusinesses(projects: readonly ListedProject[], now: () => Date = () => new Date()): Promise<BusinessListItem[]> {
  const at = now().toISOString()
  const out: BusinessListItem[] = []
  for (const p of projects.slice(0, MAX_PROJECTS)) {
    if (!p || typeof p.folderPath !== 'string' || !p.folderPath || p.source === 'ssh') continue
    try {
      const item = await readItem(p, at)
      if (item) out.push(item)
    } catch {
      // 読めないプロジェクト（消えたフォルダ・壊れた business.yaml・リンク）は一覧に出さない
    }
  }
  return out
}
