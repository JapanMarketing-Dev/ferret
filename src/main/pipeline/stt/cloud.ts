/**
 * OpenAI の /v1/audio/transcriptions と形の違う、文字起こしの API のアダプタ。
 * 提供元ごとに「要求の組み立て」と「応答の読み取り」だけを持ち、送信・費用の上限・失敗の扱いは共通にする。
 *
 * - azure-openai: {endpoint}/openai/deployments/{デプロイ名}/audio/transcriptions?api-version=…、ヘッダー api-key
 * - deepgram:     {base}/listen?model=…（本文は WAV そのもの）、ヘッダー Authorization: Token …
 * - elevenlabs:   {base}/speech-to-text（multipart の file と model_id）、ヘッダー xi-api-key
 * - gemini:       {base}/models/{model}:generateContent（音声を base64 で inline_data に入れる）、ヘッダー x-goog-api-key
 * - chat-audio:   {base}/chat/completions（input_audio。OpenRouter の音声入力に対応したモデル）、Authorization: Bearer
 * - cloudflare-run: {https://api.cloudflare.com/client/v4/accounts/<id>/ai}/run/{model}。本文は JSON の audio（base64）、Authorization: Bearer <API トークン>
 *   （Workers AI の OpenAI 互換の入口は chat・embeddings・responses だけで、文字起こしは無い）
 * - vercel-transcription: {https://ai-gateway.vercel.sh}/v4/ai/transcription-model。本文は JSON の audio（base64）と mediaType、
 *   モデルは ai-model-id ヘッダー（OpenAI 互換ではない。2026-10 時点でベータ）
 *
 * どれも利用者の端末から、利用者のキーで直接送る。キーは要求のヘッダーにだけ入れ、ログ・エラーに出さない。
 * OpenAI 互換（OpenAI / Groq / Mistral / 互換サーバー）は openai.ts の OpenAiSttEngine を使う。
 */
import { readFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  DEFAULT_AZURE_API_VERSION,
  STT_PROVIDER_PRESETS,
  authHeaders,
  providerLabel,
  resolveEndpoint,
  type AiEndpointConfig,
  type SttApiKind,
  type SttRemoteProvider,
} from '@shared/aiProviders'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import { readBoundedJson, readErrorText } from '../../boundedResponse'
import type { TranscriptSegment } from '../types'
import { SttHttpError, type SttEngine, type TranscribeChunkInput, type TranscribeResult } from './engine'
import { costLimitForEndpoint, exceedsCostLimit, normalizeBaseUrl } from './endpoint'
import { recordedSttFetch } from './usage'
import { OPENAI_MAX_BYTES, OpenAiSttEngine, UNKNOWN_PRICE_PER_MINUTE_USD, describeHttpFailure, redact } from './openai'
import { wavDurationMs, writeWavFile } from './wav'
import type { SttLanguage } from './whisper'
import { cleanText } from './whisper'

/** 時刻を返さない API（Gemini・chat-audio）に渡す指示。原文だけを返させる */
const TRANSCRIBE_INSTRUCTION = 'Transcribe this audio verbatim. Output only the transcript text, with no commentary. If there is no speech, output nothing.'

export interface CloudSttOptions {
  kind: Exclude<SttApiKind, 'openai-transcriptions'>
  /** エラー・費用上限のメッセージに出す名前 */
  label: string
  /** 末尾の / は落とす。azure はリソースの URL（https://<name>.openai.azure.com） */
  baseUrl: string
  /** azure はデプロイ名 */
  model: string
  apiKey?: string
  headers?: Record<string, string>
  apiVersion?: string
  /** 提供元の id（使用量の記録に使う） */
  provider?: string
  /** 認証の形の上書き（settings.json の authScheme / authHeader） */
  authScheme?: AiEndpointConfig['authScheme']
  authHeader?: string
  language?: SttLanguage
  /** 概算の単価($/分)。null は分からない（多めの概算で判定） */
  pricePerMinuteUsd?: number | null
  maxCostUsd?: number | null
  timeoutMs?: number
}

interface SttHttpRequest {
  url: string
  headers: Record<string, string>
  body: FormData | Blob | string
}

/** 1区間分の読み取り結果。start/end は秒 */
interface ParsedTranscript {
  text: string
  segments?: Array<{ start: number; end: number; text: string }>
  durationSec?: number
}

const trimSlash = (s: string) => s.trim().replace(/\/+$/, '')

/** 提供元ごとの要求の組み立て（単体テストから使うため export） */
export function buildCloudSttRequest(opt: CloudSttOptions, wav: Buffer, fileName: string): SttHttpRequest {
  const base = trimSlash(opt.baseUrl)
  // /v1 の有無にかかわらず同じ入口にする（Deepgram・ElevenLabs・OpenRouter）。Gemini は v1beta なので落とさない
  const v1 = `${normalizeBaseUrl(opt.baseUrl) ?? base}/v1`
  const key = opt.apiKey ?? ''
  // 認証の形は設定（authScheme / authHeader）で変えられる。無ければ提供元の既定の形。キーが無ければ付けない
  const auth = (fallback: Record<string, string>) => authHeaders(opt, key, fallback)
  const lang = opt.language && opt.language !== 'auto' ? opt.language : undefined
  const extra = opt.headers ?? {}
  switch (opt.kind) {
    case 'azure-openai': {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), fileName)
      form.append('response_format', 'json')
      if (lang) form.append('language', lang)
      const version = encodeURIComponent(opt.apiVersion || DEFAULT_AZURE_API_VERSION)
      return { url: `${base}/openai/deployments/${encodeURIComponent(opt.model)}/audio/transcriptions?api-version=${version}`,
        headers: { ...extra, ...auth({ 'api-key': key }) }, body: form }
    }
    case 'deepgram': {
      const q = new URLSearchParams({ model: opt.model, smart_format: 'true', utterances: 'true' })
      if (lang) q.set('language', lang)
      else q.set('detect_language', 'true')
      return { url: `${v1}/listen?${q.toString()}`, headers: { ...extra, ...auth({ Authorization: `Token ${key}` }), 'Content-Type': 'audio/wav' }, body: new Blob([new Uint8Array(wav)], { type: 'audio/wav' }) }
    }
    case 'elevenlabs': {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), fileName)
      form.append('model_id', opt.model)
      if (lang) form.append('language_code', lang)
      return { url: `${v1}/speech-to-text`, headers: { ...extra, ...auth({ 'xi-api-key': key }) }, body: form }
    }
    case 'gemini': {
      const body = { contents: [{ role: 'user', parts: [{ text: TRANSCRIBE_INSTRUCTION + (lang ? ` The language is ${lang}.` : '') },
        { inline_data: { mime_type: 'audio/wav', data: wav.toString('base64') } }] }] }
      return { url: `${base}/models/${encodeURIComponent(opt.model)}:generateContent`,
        headers: { ...extra, ...auth({ 'x-goog-api-key': key }), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    }
    case 'chat-audio': {
      const body = { model: opt.model, messages: [{ role: 'user', content: [
        { type: 'text', text: TRANSCRIBE_INSTRUCTION + (lang ? ` The language is ${lang}.` : '') },
        { type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } },
      ] }] }
      return { url: `${v1}/chat/completions`,
        headers: { ...extra, ...auth({ Authorization: `Bearer ${key}` }), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    }
    case 'cloudflare-run': {
      // 整理（chat）と同じ .../ai/v1 を入れられても動くように、末尾の /v1 は落とす
      const ai = base.replace(/\/v1$/, '')
      // モデル名の @cf/… は資料どおりそのまま（@ はエンコードしない）
      return { url: `${ai}/run/${opt.model.split('/').map((p) => encodeURIComponent(p).replace(/^%40/, '@')).join('/')}`,
        headers: { ...extra, ...auth({ Authorization: `Bearer ${key}` }), 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: wav.toString('base64'), ...(lang ? { language: lang } : {}) }) }
    }
    case 'vercel-transcription': {
      const origin = base.replace(/\/v\d+$/, '')
      return { url: `${origin}/v4/ai/transcription-model`,
        headers: { ...extra, ...auth({ Authorization: `Bearer ${key}` }), 'Content-Type': 'application/json', 'ai-model-id': opt.model,
          'ai-gateway-protocol-version': '0.0.1', 'ai-transcription-model-specification-version': '4' },
        body: JSON.stringify({ audio: wav.toString('base64'), mediaType: 'audio/wav' }) }
    }
  }
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** 提供元ごとの応答の読み取り（単体テストから使うため export） */
export function parseCloudSttResponse(kind: CloudSttOptions['kind'], json: unknown): ParsedTranscript {
  const r = rec(json)
  switch (kind) {
    case 'azure-openai':
      return { text: str(r.text), durationSec: num(r.duration) }
    case 'deepgram': {
      const results = rec(r.results)
      const utterances = arr(results.utterances).map(rec)
      const alt = rec(arr(rec(arr(results.channels)[0]).alternatives)[0])
      return {
        text: str(alt.transcript),
        segments: utterances.length ? utterances.map((u) => ({ start: num(u.start) ?? 0, end: num(u.end) ?? num(u.start) ?? 0, text: str(u.transcript) })) : undefined,
        durationSec: num(rec(r.metadata).duration),
      }
    }
    case 'elevenlabs':
      return { text: str(r.text) }
    case 'gemini': {
      const parts = arr(rec(rec(arr(r.candidates)[0]).content).parts).map(rec)
      return { text: parts.map((p) => str(p.text)).join('') }
    }
    case 'chat-audio': {
      const content = rec(rec(arr(r.choices)[0]).message).content
      // content は文字列か、{type:'text', text} の配列
      return { text: typeof content === 'string' ? content : arr(content).map((c) => str(rec(c).text)).join('') }
    }
    case 'cloudflare-run': {
      // { result: { text, segments: [{ start, end, text }] }, success }
      const result = rec(r.result)
      const segments = arr(result.segments).map(rec)
      return { text: str(result.text), ...(segments.length ? { segments: segments.map((g) => ({ start: num(g.start) ?? 0, end: num(g.end) ?? num(g.start) ?? 0, text: str(g.text) })) } : {}) }
    }
    case 'vercel-transcription': {
      // AI SDK の文字起こしの結果の形（text・segments の startSecond / endSecond・durationInSeconds）
      const segments = arr(r.segments).map(rec)
      return { text: str(r.text), durationSec: num(r.durationInSeconds),
        ...(segments.length ? { segments: segments.map((g) => ({ start: num(g.startSecond) ?? 0, end: num(g.endSecond) ?? num(g.startSecond) ?? 0, text: str(g.text) })) } : {}) }
    }
  }
}

export class CloudSttEngine implements SttEngine {
  readonly id: string
  readonly sendsAudioOffDevice = true
  private reservedCostUsd = 0

  constructor(private readonly opt: CloudSttOptions) {
    if (!trimSlash(opt.baseUrl) || !/^https?:\/\//i.test(opt.baseUrl.trim())) throw new UserFacingError(t('stt.errors.badBaseUrl'))
    this.id = `${opt.kind}:${opt.model}`
  }

  async available(): Promise<boolean> {
    return !!this.opt.apiKey
  }

  async transcribeChunk(input: TranscribeChunkInput): Promise<TranscribeResult> {
    const bytes = await readFile(input.wavPath)
    if (bytes.byteLength > OPENAI_MAX_BYTES) {
      throw new UserFacingError(t('stt.errors.tooLarge', { size: (bytes.byteLength / 1024 / 1024).toFixed(1) }))
    }
    const durationMs = input.durationMs ?? (await wavDurationMs(input.wavPath))
    const price = this.opt.pricePerMinuteUsd ?? UNKNOWN_PRICE_PER_MINUTE_USD
    const cost = durationMs / 60_000 * price
    const knownPrice = typeof this.opt.pricePerMinuteUsd === 'number'
    if (exceedsCostLimit(this.reservedCostUsd, cost, this.opt.maxCostUsd)) throw new UserFacingError(t('stt.errors.costLimit', { label: this.opt.label }))
    this.reservedCostUsd += cost

    const req = buildCloudSttRequest(this.opt, bytes, basename(input.wavPath))
    const started = Date.now()
    const res = await recordedSttFetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(this.opt.timeoutMs ?? 120_000) },
      { provider: this.opt.provider, model: this.opt.model, durationSec: durationMs / 1000, requestBytes: bytes.byteLength, ...(knownPrice ? { estimateUsd: cost } : {}) })
    const elapsedMs = Date.now() - started
    if (!res.ok) {
      // 失敗の本文は説明に使うだけ（想定内）
      const body = redact(await readErrorText(res), this.opt.apiKey).slice(0, 500)
      throw new SttHttpError(t('stt.errors.failed', { label: this.opt.label, status: res.status, body }), res.status, body)
    }
    const parsed = parseCloudSttResponse(this.opt.kind, await readBoundedJson(res))
    return {
      segments: toSegments(parsed, input, durationMs),
      elapsedMs,
      // URL にキーは入らない（どの提供元もヘッダーで渡す）
      commandLine: `POST ${req.url.split('?')[0]} model=${this.opt.model}`,
      billedSeconds: Math.round(parsed.durationSec ?? durationMs / 1000),
    }
  }
}

/** 時刻があれば区間ごと、無ければチャンク全体を1区間にする */
export function toSegments(parsed: ParsedTranscript, input: TranscribeChunkInput, durationMs: number): TranscriptSegment[] {
  if (parsed.segments?.length) {
    return parsed.segments.flatMap((s) => {
      const text = cleanText(s.text)
      if (!text) return []
      const t0 = input.offsetMs + Math.round(s.start * 1000)
      return [{ t0, t1: Math.max(t0, input.offsetMs + Math.round(s.end * 1000)), speaker: input.speaker, text, source: input.source }]
    })
  }
  const text = cleanText(parsed.text)
  return text ? [{ t0: input.offsetMs, t1: input.offsetMs + durationMs, speaker: input.speaker, text, source: input.source }] : []
}

interface SttEngineSpec {
  provider: SttRemoteProvider
  endpoint?: AiEndpointConfig
  apiKey?: string
  language?: SttLanguage
  maxCostUsd?: number | null
}

/** 提供元のプリセットに設定の上書きを重ね、使うエンジンを作る。キーが要るのに無ければ投げる */
export function createSttEngine(spec: SttEngineSpec): SttEngine {
  const preset = STT_PROVIDER_PRESETS[spec.provider]
  const ep = resolveEndpoint(preset, spec.endpoint)
  if (preset.keyRequired && !spec.apiKey) throw new UserFacingError(t('stt.errors.keyMissing', { label: providerLabel(preset, t) }))
  if (!ep.model) throw new UserFacingError(t('stt.check.noModel'))
  // 端末内・LAN のサーバーには費用の上限をかけない（費用がかからない。costLimitForEndpoint）
  const common = { language: spec.language, maxCostUsd: costLimitForEndpoint(ep.baseUrl, spec.maxCostUsd), headers: ep.headers, pricePerMinuteUsd: preset.pricePerMinuteUsd,
    authScheme: spec.endpoint?.authScheme, authHeader: spec.endpoint?.authHeader, provider: spec.provider }
  if (preset.kind === 'openai-transcriptions') {
    return new OpenAiSttEngine({ ...common, model: ep.model, baseUrl: ep.baseUrl, apiKey: spec.apiKey, keyOptional: !preset.keyRequired,
      label: providerLabel(preset, t), timeoutMs: ep.timeoutMs ?? (spec.provider === 'openai' ? 30_000 : 120_000),
      // Mistral は OpenAI の追加の項目（response_format など）を受け付けないことがあるので最小限だけ送る
      minimalForm: spec.provider === 'mistral' })
  }
  return new CloudSttEngine({ ...common, kind: preset.kind, label: providerLabel(preset, t), baseUrl: ep.baseUrl, model: ep.model, apiKey: spec.apiKey,
    apiVersion: ep.apiVersion, timeoutMs: ep.timeoutMs })
}

/**
 * 「接続を確認」。1秒の無音を実際のエンジンで送り、届くかどうかを日本語で返す。
 * 費用の上限は外す（1秒分だけ）。状態コードから認証・URL・モデル名の誤りを言い分ける。
 */
export async function checkSttEngine(spec: SttEngineSpec): Promise<{ ok: boolean; message: string }> {
  const preset = STT_PROVIDER_PRESETS[spec.provider]
  let engine: SttEngine
  try {
    engine = createSttEngine({ ...spec, maxCostUsd: null })
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
  const dir = await mkdtemp(join(tmpdir(), 'ade-stt-check-'))
  const wavPath = join(dir, 'ade-check.wav')
  try {
    await writeWavFile(wavPath, new Int16Array(16_000), 16_000)
    await engine.transcribeChunk({ wavPath, offsetMs: 0, speaker: 'self', source: 'mic', durationMs: 1000 })
    return { ok: true, message: t('stt.check.ok', { label: providerLabel(preset, t), model: resolveEndpoint(preset, spec.endpoint).model }) }
  } catch (e) {
    if (e instanceof SttHttpError) return { ok: false, message: describeHttpFailure(e.status, e.body, providerLabel(preset, t)) }
    const name = e instanceof Error ? e.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, message: t('stt.check.timeout', { label: providerLabel(preset, t) }) }
    if (e instanceof TypeError) return { ok: false, message: t('stt.check.unreachable', { base: resolveEndpoint(preset, spec.endpoint).baseUrl }) }
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
