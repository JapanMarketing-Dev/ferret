/**
 * 設定の「モデルをダウンロード」の裏側。端末内の文字起こし（無料）を1クリックで使えるようにする。
 *
 * - 置き場所は userData/models（models.ts の downloadedWhisperModelPath）
 * - 同時に落とすのは1つだけ。中止は AbortController で、途中ファイル（.part）は残して次回は続きから
 * - 落とし終えたら sha256 を照合する（download.ts）
 * - whisper.cpp の実行ファイル（whisper-cli）は落とさない。OS ごとの入れ方を案内するだけ
 *
 * Electron に依存しない（単体テストで download を差し替えるため）。
 */
import { existsSync } from 'node:fs'
import { t } from '@shared/i18n'
import type { WhisperModelStatus, WhisperModelProgress } from '@shared/types'
import { ModelDownloadError, downloadWhisperModel, partialDownloadSize, type DownloadOptions } from './download'
import { defaultWhisperModel, downloadedWhisperModelPath, selectableWhisperModels, whisperModels, type WhisperModelId } from './models'

type ModelDownloadResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'aborted' | 'failed'; message: string; resumable: boolean }

type Download = (id: WhisperModelId, dest: string, options: DownloadOptions) => Promise<void>

export class WhisperModelDownloads {
  private current: { id: WhisperModelId; controller: AbortController } | null = null

  constructor(private readonly userDataDir: string, private readonly download: Download = downloadWhisperModel) {}

  pathOf(id: WhisperModelId): string {
    return downloadedWhisperModelPath(this.userDataDir, id)
  }

  /** 画面に出す一覧（小さい順）。おすすめ（GPU の有無で変わる。environment.ts の chooseWhisperModel）に recommended を付ける */
  async list(recommended: WhisperModelId = defaultWhisperModel): Promise<WhisperModelStatus[]> {
    return Promise.all(selectableWhisperModels.map(async (id) => {
      const info = whisperModels[id]
      return {
        id,
        bytes: info.bytes,
        recommended: id === recommended,
        downloaded: existsSync(this.pathOf(id)),
        partialBytes: await partialDownloadSize(this.pathOf(id)),
      }
    }))
  }

  downloading(): WhisperModelId | null {
    return this.current?.id ?? null
  }

  /** 落とし終えるまで待つ。失敗・中止は投げずに結果で返す（画面で再試行を出すため） */
  async start(id: WhisperModelId, onProgress?: (p: WhisperModelProgress) => void): Promise<ModelDownloadResult> {
    if (this.current) return { ok: false, reason: 'failed', message: t('stt.model.busy'), resumable: false }
    const controller = new AbortController()
    this.current = { id, controller }
    const dest = this.pathOf(id)
    try {
      await this.download(id, dest, {
        signal: controller.signal,
        onProgress: (p) => onProgress?.({ modelId: id, phase: 'download', receivedBytes: p.receivedBytes, totalBytes: p.totalBytes ?? whisperModels[id].bytes }),
        onVerifying: () => onProgress?.({ modelId: id, phase: 'verify', receivedBytes: whisperModels[id].bytes, totalBytes: whisperModels[id].bytes }),
      })
      return { ok: true, path: dest }
    } catch (e) {
      if (controller.signal.aborted || (e instanceof ModelDownloadError && e.kind === 'aborted')) {
        return { ok: false, reason: 'aborted', message: e instanceof Error ? e.message : String(e), resumable: true }
      }
      return { ok: false, reason: 'failed', message: e instanceof Error ? e.message : String(e), resumable: e instanceof ModelDownloadError ? e.resumable : false }
    } finally {
      this.current = null
    }
  }

  /** 落としている最中なら中止する。中止したら true */
  cancel(): boolean {
    if (!this.current) return false
    this.current.controller.abort()
    return true
  }
}

/** whisper-cli の入れ方。パッケージ名を確かめられたものだけコマンドを出し、ほかは公式の手順へ案内する */
export function whisperInstallHint(platform: NodeJS.Platform): { command?: string; url: string } {
  const url = 'https://github.com/ggml-org/whisper.cpp'
  if (platform === 'darwin') return { command: 'brew install whisper-cpp', url }
  // Windows は公式のリリースに whisper-cli.exe 入りの zip がある。展開して PATH に置く
  if (platform === 'win32') return { url: `${url}/releases` }
  // Linux は配布元ごとにパッケージの有無が違うので、ソースからのビルド手順を出す
  return { command: 'git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp && cmake -B build && cmake --build build -j --config Release', url }
}
