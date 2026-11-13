/**
 * この PC のメモリ（と NVIDIA の GPU の VRAM）から、Ollama で動かすモデルの推奨を出す（選び方は @shared/localModels）。
 * メモリは os.totalmem() ですぐ分かる。VRAM は nvidia-smi を1回だけ非同期に聞き（macOS では聞かない）、分かるまではメモリだけで選ぶ。
 * Electron に依存させない（単体テストで呼べるように）。
 */
import { execFile } from 'node:child_process'
import { arch, cpus, platform, totalmem } from 'node:os'
import { parseNvidiaSmiVram, recommendLocalModels, type HardwareInfo, type LocalModelRecommendation } from '@shared/localModels'

let gpuVramBytes: number | undefined
let probing: Promise<void> | null = null

export function hardwareInfo(): HardwareInfo {
  const vram = gpuVramBytes
  return {
    totalMemBytes: totalmem(),
    platform: platform(),
    arch: arch(),
    cpuModel: cpus()[0]?.model,
    ...(vram ? { gpuVramBytes: vram } : {})
  }
}

/** NVIDIA の GPU の VRAM を1回だけ聞く（入っていなければ何もしない。失敗は想定内なので黙る） */
function probeGpu(run: typeof execFile = execFile): Promise<void> {
  if (platform() === 'darwin') return Promise.resolve()
  probing ??= new Promise<void>((resolve) => {
    try {
      run('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { timeout: 3000, windowsHide: true }, (err, stdout) => {
        if (!err) gpuVramBytes = parseNvidiaSmiVram(String(stdout))
        resolve()
      })
    } catch {
      resolve() // nvidia-smi が無い（想定内）
    }
  })
  return probing
}

/** 今わかっている範囲での推奨。VRAM はまだ聞いていなければ聞き始める（結果は次の呼び出しから効く） */
export function localModelRecommendation(): LocalModelRecommendation {
  void probeGpu()
  return recommendLocalModels(hardwareInfo())
}

type LocalServerState = 'ok' | 'down' | 'noModel'

/**
 * 端末内のサーバー（Ollama・LM Studio の OpenAI 互換 /v1）が動いていて、そのモデルが入っているか。整理を始める前に1回だけ聞く
 * （動いていないと、長く待ったあと「整理できませんでした」としか出せないため）。キーは送らない
 */
export async function checkLocalServer(baseUrl: string, model: string, fetchImpl: typeof fetch = fetch, timeoutMs = 3000): Promise<LocalServerState> {
  let res: Response
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    return 'down' // 起動していない・入っていない（想定内）
  }
  if (!res.ok) {
    // 読まない本文は捨てておく（つないだままにすると Node の fetch の内部で例外になり main が落ちうる。Orca #8695）
    await res.body?.cancel().catch(() => undefined)
    return 'down'
  }
  const body = await res.json().catch(() => null) as { data?: Array<{ id?: unknown }> } | null
  const ids = Array.isArray(body?.data) ? body.data.map((m) => String(m.id ?? '')) : []
  // Ollama は「名前:latest」で返すことがある。名前だけで頼んだものも同じとみなす
  const has = ids.some((id) => id === model || id === `${model}:latest` || id.replace(/:latest$/, '') === model)
  return !model || has ? 'ok' : 'noModel'
}
