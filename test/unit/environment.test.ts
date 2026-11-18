import { describe, expect, it } from 'vitest'
import {
  chooseWhisperModel,
  clearWhisperGpuCache,
  detectGpu,
  pickLocalWhisperModel,
  whisperThreads,
  whisperUsesGpu,
  detectLlmRuntime,
  resolveWhisperBinary,
  resolveWhisperRuntime,
  whisperModelPath
} from '../../src/main/pipeline/environment'
import type { EnvironmentProbes } from '../../src/main/pipeline/environment'

/** 既定は「何も見つからない」。テストごとに必要なものだけ生やす */
function probes(overrides: Partial<EnvironmentProbes> = {}): EnvironmentProbes {
  return {
    platform: 'darwin',
    arch: 'arm64',
    exists: () => false,
    which: () => null,
    ...overrides
  }
}

const paths = { modelDir: '/userdata/models' }

describe('whisper の実行ファイルを探す', () => {
  it('同梱したものを最優先で使う（配布時）', async () => {
    const found = await resolveWhisperBinary(
      { ...paths, resourcesDir: '/app/resources' },
      probes({
        exists: (p) => p === '/app/resources/whisper/darwin-arm64/whisper-cli',
        which: () => '/opt/homebrew/bin/whisper-cli'
      })
    )
    expect(found).toBe('/app/resources/whisper/darwin-arm64/whisper-cli')
  })

  it('Windows では .exe を探す', async () => {
    const found = await resolveWhisperBinary(
      { ...paths, resourcesDir: 'C:\\app\\resources' },
      probes({
        platform: 'win32',
        arch: 'x64',
        exists: (p) => p === 'C:\\app\\resources\\whisper\\win32-x64\\whisper-cli.exe'
      })
    )
    expect(found).toBe('C:\\app\\resources\\whisper\\win32-x64\\whisper-cli.exe')
  })

  it('同梱が無ければ PATH 上のものを使う（開発時）', async () => {
    const found = await resolveWhisperBinary(paths, probes({ which: () => '/usr/local/bin/whisper-cli' }))
    expect(found).toBe('/usr/local/bin/whisper-cli')
  })

  it('PATH に無ければ Homebrew の既定の場所を見る', async () => {
    const found = await resolveWhisperBinary(
      paths,
      probes({ exists: (p) => p === '/opt/homebrew/bin/whisper-cli' })
    )
    expect(found).toBe('/opt/homebrew/bin/whisper-cli')
  })

  it('どこにも無ければ null', async () => {
    expect(await resolveWhisperBinary(paths, probes())).toBeNull()
  })
})

describe('モデルの置き場所', () => {
  it('ユーザー設定フォルダの下に置く（プロジェクトを汚さない。NF-9）', () => {
    expect(whisperModelPath(paths, 'large-v3-turbo')).toBe(
      '/userdata/models/ggml-large-v3-turbo.bin'
    )
    expect(whisperModelPath(paths, 'small')).toBe('/userdata/models/ggml-small.bin')
  })
})

describe('GPUの判定とモデルの既定', () => {
  it('whisper-cli が読み込んだバックエンドから判定する', async () => {
    const metal = await detectGpu(
      '/bin/whisper-cli',
      probes({ run: async () => 'load_backend: loaded MTL backend from /opt/...' })
    )
    expect(metal).toBe(true)

    const cuda = await detectGpu(
      '/bin/whisper-cli',
      probes({ platform: 'linux', run: async () => 'load_backend: loaded CUDA backend' })
    )
    expect(cuda).toBe(true)

    const cpuOnly = await detectGpu(
      '/bin/whisper-cli',
      probes({ platform: 'linux', run: async () => 'load_backend: loaded CPU backend' })
    )
    expect(cpuOnly).toBe(false)
  })

  it('実行できない場合は、macOS だけ GPU ありとみなす（控えめな既定）', async () => {
    expect(await detectGpu('/bin/whisper-cli', probes({ run: async () => null }))).toBe(true)
    expect(
      await detectGpu('/bin/whisper-cli', probes({ platform: 'win32', run: async () => null }))
    ).toBe(false)
    // 実行ファイル自体が無い場合も既定で判断する
    expect(await detectGpu(null, probes({ platform: 'linux' }))).toBe(false)
  })

  it('CPUのみなら量子化した large-v3-turbo-q5_0 をすすめる（f16 は CPU で遅い。small は日本語の精度が落ちる。Issue #13）', () => {
    expect(chooseWhisperModel(true)).toBe('large-v3-turbo')
    expect(chooseWhisperModel(false)).toBe('large-v3-turbo-q5_0')
  })

  it('Windows の公式の CPU 版（load_backend が CPU だけ）は GPU なし。Vulkan・静的リンクの CUDA・Metal の初期化の行は GPU あり', async () => {
    const win = (out: string) => detectGpu('C:\\w\\whisper-cli.exe', probes({ platform: 'win32', run: async () => out }))
    expect(await win('load_backend: loaded CPU backend from C:\\w\\ggml-cpu-zen4.dll')).toBe(false)
    expect(await win('load_backend: loaded Vulkan backend from C:\\w\\ggml-vulkan.dll\nload_backend: loaded CPU backend')).toBe(true)
    expect(await win('ggml_cuda_init: found 1 CUDA devices:')).toBe(true)
    expect(await win('ggml_cuda_init: found 0 CUDA devices:')).toBe(false)
    expect(await win('ggml_vulkan: Found 1 Vulkan devices:')).toBe(true)
    expect(await win('whisper_backend_init_gpu: using Vulkan0 backend')).toBe(true)
    expect(await win('load_backend: loaded BLAS backend')).toBe(false)
  })
})

describe('whisper-cli のスレッド数（-t。Issue #13）', () => {
  it('論理コアの半分を使い、4〜16 に収める。コアが 4 以下ならその数。壊れた値は 4', () => {
    expect(whisperThreads(32)).toBe(16)
    expect(whisperThreads(64)).toBe(16)
    expect(whisperThreads(24)).toBe(12)
    expect(whisperThreads(16)).toBe(8)
    expect(whisperThreads(10)).toBe(5)
    expect(whisperThreads(8)).toBe(4)
    expect(whisperThreads(6)).toBe(4)
    expect(whisperThreads(5)).toBe(4)
    expect(whisperThreads(4)).toBe(4)
    expect(whisperThreads(2)).toBe(2)
    expect(whisperThreads(1)).toBe(1)
    expect(whisperThreads(0)).toBe(4)
    expect(whisperThreads(-3)).toBe(4)
    expect(whisperThreads(Number.NaN)).toBe(4)
    expect(whisperThreads(33.9)).toBe(16)
  })
})

describe('GPU の判定を覚える（whisperUsesGpu）', () => {
  it('同じ実行ファイルは1度だけ調べる。実行ファイルが違えば別に調べる', async () => {
    clearWhisperGpuCache()
    let runs = 0
    const p = probes({ platform: 'win32', run: async () => { runs++; return 'load_backend: loaded CPU backend' } })
    expect(await whisperUsesGpu('C:\\a\\whisper-cli.exe', p)).toBe(false)
    expect(await whisperUsesGpu('C:\\a\\whisper-cli.exe', p)).toBe(false)
    expect(runs).toBe(1)
    expect(await whisperUsesGpu('C:\\b\\whisper-cli.exe', p)).toBe(false)
    expect(runs).toBe(2)
  })

  it('調べるのが遅ければ OS の既定で答え、結果はあとで使う。調べるのが失敗しても OS の既定', async () => {
    clearWhisperGpuCache()
    let finish: (v: string) => void = () => {}
    const p = probes({ platform: 'win32', run: () => new Promise<string>((r) => { finish = r }) })
    expect(await whisperUsesGpu('/w', p, 5)).toBe(false)
    finish('load_backend: loaded CUDA backend')
    expect(await whisperUsesGpu('/w', p, 5)).toBe(true)
    clearWhisperGpuCache()
    expect(await whisperUsesGpu('/m', probes({ platform: 'darwin', run: async () => { throw new Error('x') } }))).toBe(true)
    expect(await whisperUsesGpu('/l', probes({ platform: 'linux', run: async () => { throw new Error('x') } }))).toBe(false)
  })
})

describe('使うモデルのファイル（pickLocalWhisperModel）', () => {
  const pathOf = (id: string) => `/m/ggml-${id}.bin`
  const base = { pathOf, fallback: '/old/ggml-small.bin' } as const
  it('利用者が選んだものを最優先する', () => {
    expect(pickLocalWhisperModel({ ...base, explicit: '/x/mine.bin', gpu: false, exists: () => true })).toBe('/x/mine.bin')
  })
  it('GPU は large-v3-turbo、CPU は large-v3-turbo-q5_0 を先に選ぶ。無ければ取得済みのほか、何も無ければ古い置き場所', () => {
    const all = () => true
    expect(pickLocalWhisperModel({ ...base, gpu: true, exists: all })).toBe('/m/ggml-large-v3-turbo.bin')
    expect(pickLocalWhisperModel({ ...base, gpu: false, exists: all })).toBe('/m/ggml-large-v3-turbo-q5_0.bin')
    const only = (name: string) => (p: string) => p === `/m/ggml-${name}.bin`
    expect(pickLocalWhisperModel({ ...base, gpu: false, exists: only('large-v3-turbo') })).toBe('/m/ggml-large-v3-turbo.bin')
    expect(pickLocalWhisperModel({ ...base, gpu: true, exists: only('large-v3-turbo-q5_0') })).toBe('/m/ggml-large-v3-turbo-q5_0.bin')
    expect(pickLocalWhisperModel({ ...base, gpu: true, exists: only('small') })).toBe('/m/ggml-small.bin')
    expect(pickLocalWhisperModel({ ...base, gpu: false, exists: () => false, explicit: '' })).toBe('/old/ggml-small.bin')
  })
})

describe('whisper の実行環境をまとめて解決する', () => {
  it('実行ファイル・モデル・GPU・未ダウンロードを一度に返す', async () => {
    const runtime = await resolveWhisperRuntime(
      paths,
      probes({
        which: () => '/opt/homebrew/bin/whisper-cli',
        run: async () => 'loaded MTL backend'
      })
    )
    expect('error' in runtime).toBe(false)
    if ('error' in runtime) return
    expect(runtime.binary).toBe('/opt/homebrew/bin/whisper-cli')
    expect(runtime.gpuAvailable).toBe(true)
    expect(runtime.modelId).toBe('large-v3-turbo')
    expect(runtime.needsDownload).toBe(true)
  })

  it('CPUのみの端末では large-v3-turbo-q5_0 になる（Issue #13）', async () => {
    const runtime = await resolveWhisperRuntime(
      paths,
      probes({
        platform: 'win32',
        which: () => 'C:\\tools\\whisper-cli.exe',
        run: async () => 'loaded CPU backend'
      })
    )
    if ('error' in runtime) throw new Error('解決できるはず')
    expect(runtime.modelId).toBe('large-v3-turbo-q5_0')
    expect(runtime.gpuAvailable).toBe(false)
  })

  it('モデルが既にあれば needsDownload は false', async () => {
    const runtime = await resolveWhisperRuntime(
      paths,
      probes({
        which: () => '/bin/whisper-cli',
        exists: (p) => p === '/userdata/models/ggml-large-v3-turbo.bin',
        run: async () => 'loaded MTL backend'
      })
    )
    if ('error' in runtime) throw new Error('解決できるはず')
    expect(runtime.needsDownload).toBe(false)
  })

  it('設定でモデルを明示したらそれに従う', async () => {
    const runtime = await resolveWhisperRuntime(
      paths,
      probes({ which: () => '/bin/whisper-cli', run: async () => 'loaded MTL backend' }),
      { modelId: 'small' }
    )
    if ('error' in runtime) throw new Error('解決できるはず')
    expect(runtime.modelId).toBe('small')
  })

  it('実行ファイルが無ければ error を返す（例外にしない）', async () => {
    const runtime = await resolveWhisperRuntime(paths, probes())
    expect(runtime).toEqual({ error: 'binary-not-found' })
  })
})

describe('LLM CLI の検出（設計6章）', () => {
  const both = probes({
    which: (c) => (c === 'codex' ? '/bin/codex' : c === 'claude' ? '/bin/claude' : null)
  })

  it('既定は Codex（所要時間が安定）', async () => {
    const runtime = await detectLlmRuntime(both)
    expect(runtime).toEqual({ kind: 'codex', binary: '/bin/codex' })
  })

  it('Codex が無ければ Claude Code の sonnet', async () => {
    const runtime = await detectLlmRuntime(
      probes({ which: (c) => (c === 'claude' ? '/bin/claude' : null) })
    )
    expect(runtime).toEqual({ kind: 'claude-code', binary: '/bin/claude', model: 'sonnet' })
  })

  it('設定で選ばれていればそちらを使う', async () => {
    expect((await detectLlmRuntime(both, 'claude-code'))?.kind).toBe('claude-code')
  })

  it('設定で選ばれたものが無ければ、使えるほうへ落とす', async () => {
    const runtime = await detectLlmRuntime(
      probes({ which: (c) => (c === 'claude' ? '/bin/claude' : null) }),
      'codex'
    )
    expect(runtime?.kind).toBe('claude-code')
  })

  it('どちらも無ければ null（下書きだけで進める。EXT-11）', async () => {
    expect(await detectLlmRuntime(probes())).toBeNull()
  })
})
