import { join } from 'node:path'
import { t } from '@shared/i18n'

/**
 * 引き継ぎのファイル（プロジェクトの .ferret/handoff.md）まわりの文。副作用のない部分。
 *
 * 引き継ぎは Agent の種類に依存しない形にする（会話の記録は CLI ごと・アカウントごとなので写さない）:
 * - 書くのは Agent 自身。Ferret が渡す指示文（agentPrompt の既定）に「区切りごと・上限が近づいたら更新する」を入れ、
 *   切り替える直前にも、まだ動ける Agent には「更新して」と頼む（updateRequest）
 * - 応答が無い・上限で止まっているときは、Ferret が分かる範囲（直前の依頼・feedback.md の場所・git status の変更ファイル）を追記する
 * - 次の Agent には「まずこのファイルを読み、残りの作業を続けて」と送る（nextAgentPrompt）
 * 文はアプリの表示言語。認証情報は入れない。
 */

/** プロジェクトの中の決まった場所（.ferret/ は .git/info/exclude で git 管理外。sessions/gitexclude.ts） */
export function handoffFilePath(projectDir: string): string {
  return join(projectDir, '.ferret', 'handoff.md')
}

/** 直前の依頼の上限 */
const REQUEST_MAX_CHARS = 4000
/** 変更ファイルの一覧の上限 */
const CHANGED_MAX = 200

/** 切り替える直前に、今の Agent へ送る「引き継ぎのファイルを更新して」 */
export function updateRequest(path: string): string {
  return t('failover.handoff.updateRequest', { path })
}

/** 次の Agent へ送る「まずこのファイルを読んで続けて」 */
export function nextAgentPrompt(input: { reason: 'limit' | 'return' | 'switch'; from: string; to: string; path: string }): string {
  if (input.reason === 'switch') return t('failover.handoff.readSwitch', { to: input.to, path: input.path })
  return input.reason === 'return'
    ? t('failover.handoff.readReturn', { from: input.from, to: input.to, path: input.path })
    : t('failover.handoff.readLimit', { from: input.from, to: input.to, path: input.path })
}

/** 指示文の中の feedback.md の場所（Ferret が送った指示に入っている） */
export function findFeedbackPath(text: string | null): string | null {
  if (!text) return null
  const match = /(?:^|[\s"'`(])((?:[A-Za-z]:)?[^\s"'`()]*feedback\.md)\b/.exec(text)
  return match?.[1] ?? null
}

/** git status --porcelain の出力から、変更されたファイルの行 */
export function changedFilesFrom(porcelain: string): string[] {
  return porcelain.split('\n').map((line) => line.replace(/\s+$/, '')).filter((line) => line.trim()).slice(0, CHANGED_MAX)
}

/**
 * Agent が更新できなかったときに、Ferret が追記する節。
 * fileExists が false なら、見出し（# 引き継ぎ）から書く。changedFiles が null なら git の状態は分からない（git ではない）
 */
export function ferretNote(input: {
  time: string
  agent: string
  lastRequest: string | null
  changedFiles: string[] | null
  fileExists: boolean
}): string {
  const lines: string[] = []
  if (!input.fileExists) lines.push(`# ${t('failover.note.fileTitle')}`, '')
  lines.push(`## ${t('failover.note.title', { time: input.time })}`, '', t('failover.note.intro', { agent: input.agent }), '')
  const request = input.lastRequest?.trim().slice(0, REQUEST_MAX_CHARS)
  if (request) lines.push(t('failover.note.lastRequest'), '', ...request.split('\n').map((line) => `> ${line}`), '')
  const feedback = findFeedbackPath(input.lastRequest)
  if (feedback) lines.push(t('failover.note.feedback', { path: feedback }), '')
  if (input.changedFiles) {
    if (input.changedFiles.length === 0) lines.push(t('failover.note.noChanges'), '')
    else lines.push(t('failover.note.changed'), '', '```', ...input.changedFiles, '```', '')
  }
  return `${input.fileExists ? '\n' : ''}${lines.join('\n')}`
}

/**
 * ターミナルへの入力から、最後に Enter で送られた1件を取り出す（Ferret が追記する「直前の依頼」）。
 * 貼り付け（ブラケットペースト）はまとめて1件。矢印などのキーの列は捨てる。
 * 中身はメモリの中だけに置き、ログには出さない。
 */
export class LastInputTracker {
  private line = ''
  private pasting = false
  private last: string | null = null

  push(data: string): void {
    let i = 0
    while (i < data.length) {
      if (data.startsWith('\x1b[200~', i)) {
        this.pasting = true
        i += 6
        continue
      }
      if (data.startsWith('\x1b[201~', i)) {
        this.pasting = false
        i += 6
        continue
      }
      const ch = data[i]!
      if (ch === '\x1b') {
        // 矢印・機能キーなど（ESC [ … 終端の文字）
        const match = /^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)?/.exec(data.slice(i))
        i += match?.[0].length || 1
        continue
      }
      if (this.pasting) {
        this.line += ch === '\r' ? '\n' : ch
      } else if (ch === '\r' || ch === '\n') {
        this.commit()
      } else if (ch === '\x7f' || ch === '\b') {
        this.line = this.line.slice(0, -1)
      } else if (ch === '\x03' || ch === '\x15') {
        // Ctrl+C・Ctrl+U は打ちかけを捨てる
        this.line = ''
      } else if (ch >= ' ') {
        this.line += ch
      }
      i++
      if (this.line.length > REQUEST_MAX_CHARS * 2) this.line = this.line.slice(-REQUEST_MAX_CHARS * 2)
    }
  }

  /** Ferret が「Agent へ送信」で送った指示（入力として届いた分を上書きする） */
  record(text: string): void {
    const trimmed = text.trim()
    if (trimmed) this.last = trimmed
    this.line = ''
  }

  private commit(): void {
    const trimmed = this.line.trim()
    this.line = ''
    // 1〜2文字（y / n、メニューの番号）は依頼とみなさない
    if (trimmed.length >= 3 && !trimmed.startsWith('/')) this.last = trimmed
  }

  lastRequest(): string | null {
    return this.last
  }
}
