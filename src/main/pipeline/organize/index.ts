/**
 * ③ 整理（LLM）— 「入力JSON → 出力JSON」の1関数。
 * 実行方法（runner）は差し替え可能（EXT-10）。
 * 失敗・タイムアウト・検証不合格なら ok:false を返し、呼び出し側は②の下書きを使う（EXT-11）。
 */
import { organizeOutputSchema } from '../schema'
import type { OrganizeInput, OrganizeOutput } from '../types'
import { buildPrompt } from './prompt'
import type { LlmRunner } from './runner'
import { RunnerError } from './runner'
import type { ValidationIssue } from './validate'
import { validateOrganizeOutput } from './validate'
import { reportHandled } from '@shared/report'

export interface OrganizeOptions {
  runner: LlmRunner;
  /** 子プロセスの作業フォルダ。セッションフォルダに限定する */
  cwd: string;
  /** タイムアウト(ms)。既定 90秒（NF-3 の目標は5分の録画で60秒） */
  timeoutMs?: number
  model?: string
}

export type OrganizeResult =
  | {
      ok: true
      output: OrganizeOutput
      issues: ValidationIssue[]
      elapsedMs: number
      commandLine: string;
      /** LLM が返した生テキスト（session.json に残す） */
      raw: string;
      /** CLI が報告したトークン数など（計測用） */
      usage?: Record<string, unknown>
    }
  | {
      ok: false;
      /** 失敗の理由（UIに出す。フォールバックした旨も伝える） */
      reason: string
      issues: ValidationIssue[]
      elapsedMs: number
      commandLine?: string
      raw?: string;
      /** 子プロセスの stderr の末尾（失敗の調査用） */
      stderrTail?: string
    }

export async function organize(input: OrganizeInput, options: OrganizeOptions): Promise<OrganizeResult> {
  const started = Date.now()
  const prompt = buildPrompt(input)

  let raw: string
  let elapsedMs: number
  let commandLine: string
  let usage: Record<string, unknown> | undefined
  try {
    const r = await options.runner.run({
      prompt,
      schema: organizeOutputSchema,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 90_000,
      model: options.model,
    })
    raw = r.raw
    elapsedMs = r.elapsedMs
    commandLine = r.commandLine
    usage = r.usage
  } catch (e) {
    const err = e instanceof RunnerError ? e : undefined
    // CLI・API の失敗（RunnerError）は画面に出す想定内のもの。それ以外は不具合として知らせる
    if (!err) reportHandled(e, { area: 'organize', op: 'run organizer' })
    return {
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
      issues: [],
      elapsedMs: Date.now() - started,
      commandLine: err?.commandLine,
      stderrTail: err?.stderrTail,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      ok: false,
      reason: 'LLM の出力がJSONとして読めませんでした',
      issues: [],
      elapsedMs,
      commandLine,
      raw,
    }
  }

  const validation = validateOrganizeOutput(parsed, input)
  if (!validation.ok || !validation.value) {
    return {
      ok: false,
      reason: `LLM の出力が検証に通りませんでした: ${validation.issues
        .filter((i) => i.level === 'error')
        .map((i) => i.message)
        .slice(0, 5)
        .join(' / ')}`,
      issues: validation.issues,
      elapsedMs,
      commandLine,
      raw,
    }
  }

  return {
    ok: true,
    output: validation.value,
    issues: validation.issues,
    elapsedMs,
    commandLine,
    raw,
    usage,
  }
}

export { buildPayload, buildPrompt } from './prompt'
export { validateOrganizeOutput, defaultValidateOptions } from './validate'
export type { ValidationIssue, ValidationResult } from './validate'
export type { LlmRunner, RunnerRequest, RunnerResult } from './runner'
export { RunnerError } from './runner'
export { ClaudeCodeRunner } from './runners/claudeCode'
export { CodexRunner } from './runners/codex'
export { MockRunner } from './runners/mock'
export { organizeChunked, splitInput } from './chunked'
export type { ChunkedOptions, ChunkedResult } from './chunked'
