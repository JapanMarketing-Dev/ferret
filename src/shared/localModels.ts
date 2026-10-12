/**
 * 端末内の Ollama で動かすモデルを、PC のメモリ（と分かれば GPU）から選ぶ。main が os.totalmem() などで HardwareInfo を作り、
 * 判定モデル（clef / clef-flash）と「指摘の整理」（gpt-oss / qwen3）の既定に使う。画面には結果だけを渡す（SttAvailability.localModels）。
 *
 * 根拠（2026-10-03 に ollama.com/library の各モデルの tags で確認したダウンロードの大きさ。読み込むとほぼこの大きさ＋文脈の分を食う）:
 *   clef:27b（q4_k_m）18GB / clef-flash:9b 11GB / gpt-oss:20b 14GB / gpt-oss:120b 65GB / qwen3:8b 5.2GB
 * 決め方:
 *   - Apple Silicon はメモリを GPU と分け合う。Metal が GPU に回すのは既定で物理メモリの約2/3（大きい機種で約3/4）なので、
 *     モデル＋文脈（数GB）がその中に収まり、さらに Ferret・Agent・開発サーバー・ブラウザの分（8〜12GB）が残る大きさから選ぶ
 *   - NVIDIA の GPU は VRAM に丸ごと載るかで選ぶ（nvidia-smi で分かったときだけ）。載らないと CPU と分け合って遅くなる
 *   - それ以外（Intel Mac・GPU の無い PC）は CPU で動くので、遅くならない小さい方を選ぶ
 * 載らない・難しい環境は clef-flash（判定）・qwen3:8b（整理）にする。メモリが少なすぎても止めない（遅いだけで動く）。
 *
 * 後半は「端末内・LAN のモデルか」の判定（isLocalModelEndpoint・launchUsesLocalModel）。ローカルのモデルには提供元の
 * 回数・費用の上限が無いので、Ferret の枠（判定の中継の回数・1分あたり・トークン・費用・プロジェクトの1日の枠、文字起こしの費用の上限、
 * 上限での自動切り替え）をかけない（2026-10-12 本人の指摘「clef などのローカルモデルなのに制限で使えなかった」）。
 */
import type { AgentPreferences, TuiAgent } from './types'
import { findCustomAgent, isBuiltinAgent } from './agentCatalog'

export interface HardwareInfo {
  /** 物理メモリ（バイト。os.totalmem()） */
  totalMemBytes: number
  platform: string
  arch: string
  /** os.cpus()[0].model（Rosetta で x64 の版を動かしていても Apple Silicon と分かる） */
  cpuModel?: string
  /** NVIDIA の GPU の VRAM（バイト。いちばん大きいもの）。分からなければ省略 */
  gpuVramBytes?: number
}

type DecisionLocalModel = 'clef' | 'clef-flash'

export interface LocalModelRecommendation {
  /** 判定モデル（System One 互換。画像を読む） */
  decision: DecisionLocalModel
  /** 「指摘の整理」を Ollama で動かすときのモデル */
  organize: string
}

const GiB = 1024 ** 3

/** clef を選ぶ下限。Apple Silicon の物理メモリ（約2/3の24GB に 18GB＋文脈が収まり、ほかに 12GB 残る） */
const CLEF_MIN_UNIFIED_GIB = 36
/** clef を選ぶ下限。NVIDIA の VRAM（24GB の板は 23.99GiB と出るので少し下げる） */
const CLEF_MIN_VRAM_GIB = 22
/** gpt-oss:20b を選ぶ下限（Apple Silicon・VRAM・CPU）。MoE で動く部分が小さいので CPU でも使える速さ */
const GPT_OSS_20B_MIN_UNIFIED_GIB = 32
const GPT_OSS_20B_MIN_VRAM_GIB = 15
const GPT_OSS_20B_MIN_CPU_RAM_GIB = 32
/** gpt-oss:120b を選ぶ下限（65GB） */
const GPT_OSS_120B_MIN_UNIFIED_GIB = 128
const GPT_OSS_120B_MIN_VRAM_GIB = 78

export function isAppleSilicon(hw: Pick<HardwareInfo, 'platform' | 'arch' | 'cpuModel'>): boolean {
  return hw.platform === 'darwin' && (hw.arch === 'arm64' || /^Apple M\d/i.test(hw.cpuModel ?? ''))
}

const gib = (bytes: number | undefined): number => (typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? bytes / GiB : 0)

/** 判定モデル。clef が無理なく載るときだけ clef、それ以外は clef-flash */
export function recommendDecisionModel(hw: HardwareInfo): DecisionLocalModel {
  const ram = gib(hw.totalMemBytes)
  if (isAppleSilicon(hw)) return ram >= CLEF_MIN_UNIFIED_GIB ? 'clef' : 'clef-flash'
  return gib(hw.gpuVramBytes) >= CLEF_MIN_VRAM_GIB && ram >= 16 ? 'clef' : 'clef-flash'
}

/** 整理のモデル（Ollama のモデル名） */
export function recommendOrganizeModel(hw: HardwareInfo): string {
  const ram = gib(hw.totalMemBytes)
  const vram = gib(hw.gpuVramBytes)
  if (isAppleSilicon(hw)) {
    if (ram >= GPT_OSS_120B_MIN_UNIFIED_GIB) return 'gpt-oss:120b'
    return ram >= GPT_OSS_20B_MIN_UNIFIED_GIB ? 'gpt-oss:20b' : 'qwen3:8b'
  }
  if (vram >= GPT_OSS_120B_MIN_VRAM_GIB) return 'gpt-oss:120b'
  return vram >= GPT_OSS_20B_MIN_VRAM_GIB || ram >= GPT_OSS_20B_MIN_CPU_RAM_GIB ? 'gpt-oss:20b' : 'qwen3:8b'
}

export function recommendLocalModels(hw: HardwareInfo): LocalModelRecommendation {
  return { decision: recommendDecisionModel(hw), organize: recommendOrganizeModel(hw) }
}

/**
 * nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits の出力（1行に1枚、MiB）から、いちばん大きい VRAM（バイト）。
 * 読めなければ undefined
 */
export function parseNvidiaSmiVram(stdout: string): number | undefined {
  const mibs = stdout.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => Number.isFinite(n) && n > 0)
  return mibs.length ? Math.max(...mibs) * 1024 * 1024 : undefined
}

/** 推奨の印を付け替えたモデル一覧（推奨が一覧に無ければ先頭に足す）。設定の画面が「推奨」を出すのに使う */
export function withRecommendedModel<M extends { id: string; recommended?: true }>(models: readonly M[], id: string | undefined): M[] {
  if (!id) return [...models]
  const marked = models.map((m) => {
    const { recommended: _r, ...rest } = m
    return (m.id === id ? { ...rest, recommended: true } : rest) as M
  })
  return marked.some((m) => m.id === id) ? marked : [{ id, recommended: true } as M, ...marked]
}

// ───────────────────────── 端末内・LAN のモデルか ─────────────────────────

/** IPv4 の4つの数。読めなければ null（URL が 0x7f.1 などを 127.0.0.1 に直したあとの形を読む） */
function parseIpv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p))) return null
  const nums = parts.map(Number)
  return nums.every((n) => n <= 255) ? nums : null
}

/** ループバック・プライベート・リンクローカル・CGNAT（Tailscale の 100.64.0.0/10）・0.0.0.0 */
function isLocalIpv4([a, b]: number[]): boolean {
  if (a === undefined || b === undefined) return false
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127) || a === 0
}

/** ::1・ULA（fc00::/7）・リンクローカル（fe80::/10）・IPv4 射影（::ffff:7f00:1 など。URL は16進に直す） */
function isLocalIpv6(host: string): boolean {
  const h = host.split('%')[0]!
  if (h === '::1') return true
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h)
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16)
    const lo = parseInt(mapped[2]!, 16)
    return isLocalIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff])
  }
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h)
  if (dotted) {
    const v4 = parseIpv4(dotted[1]!)
    return v4 !== null && isLocalIpv4(v4)
  }
  return /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h)
}

/** 自宅・社内の名前の末尾（mDNS の .local、ルーターの .lan、RFC 8375 の .home.arpa、Docker などの .internal、Tailscale の .ts.net） */
const LOCAL_NAME_SUFFIXES = ['.localhost', '.local', '.lan', '.home.arpa', '.internal', '.ts.net'] as const

/**
 * ホスト名が、この PC・同じ LAN（自宅の GPU の PC など）を指すか。
 * 名前の解決はしない（DNS で私的な IP を返す公開の名前は、クラウドとみなす＝枠を残す側に倒す）。
 * 点の無い名前（ubuntu-server など）は LAN のホスト名とみなす
 */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (!host) return false
  if (host === 'localhost' || LOCAL_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true
  const v4 = parseIpv4(host)
  if (v4) return isLocalIpv4(v4)
  if (host.includes(':')) return isLocalIpv6(host)
  // 数字だけの区切りなのに IPv4 として読めない（999.1.1.1 など）は公開側に倒す
  if (/^[\d.]+$/.test(host)) return false
  return !host.includes('.')
}

/**
 * 接続先の URL が端末内・LAN のモデル（Ollama・LM Studio・llama.cpp・自宅の GPU の PC など）か。
 * http(s) 以外・読めない URL・空は false（クラウドとみなし、Ferret の枠を残す）
 */
export function isLocalModelEndpoint(url: string | null | undefined): boolean {
  if (typeof url !== 'string' || !url.trim()) return false
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    // 読めない URL（想定内）。クラウドとみなす
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  return isLocalHostname(parsed.hostname)
}

/** 端末内でモデルを動かす CLI（起動のコマンドの先頭の語。パスと .exe は落として比べる） */
const LOCAL_RUNNER_COMMANDS = new Set(['ollama', 'lms', 'lmstudio', 'llama-cli', 'llama-server', 'llamafile', 'koboldcpp', 'mlx_lm.chat', 'mlx_lm.generate', 'mlx_lm.server'])

/**
 * Agent の起動（コマンドと引数）が端末内・LAN のモデルを使うか。分かる書き方だけを見る（分からなければ false＝枠を残す）:
 *   - 先頭が Ollama・LM Studio・llama.cpp などの CLI（`ollama launch claude`、`ollama run clef` など）
 *   - Codex の `--oss`（Ollama・LM Studio で動かす）、`--local-provider` / `model_provider=ollama` などの提供元の指定
 *   - aider などの `ollama/…`・`ollama_chat/…`・`lm_studio/…` のモデル名
 *   - 引数・環境変数の指定（ANTHROPIC_BASE_URL=http://localhost:11434 claude など）に入っている、端末内・LAN の URL
 */
export function launchUsesLocalModel(command: string | null | undefined, args?: string | null): boolean {
  const text = `${command ?? ''} ${args ?? ''}`.trim()
  if (!text) return false
  const words = text.split(/\s+/).map((w) => w.replace(/^['"]+|['"]+$/g, ''))
  // 先頭の環境変数の指定（NAME=値）は飛ばして、実際に動かすコマンドを見る
  const first = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? ''
  const baseOf = (path: string) => path.split(/[\\/]/).pop()!.replace(/\.exe$/i, '').toLowerCase()
  // 空白を含むパス（C:\Program Files\Ollama\ollama.exe）は、コマンドの欄をまるごと1つのパスとしても見る
  const whole = (command ?? '').trim().replace(/^['"]+|['"]+$/g, '')
  if (LOCAL_RUNNER_COMMANDS.has(baseOf(first)) || LOCAL_RUNNER_COMMANDS.has(baseOf(whole))) return true
  if (words.some((w) => w === '--oss' || w === '--local-provider' || w.startsWith('--local-provider='))) return true
  if (/\b(?:model_provider|provider)\s*=\s*["']?(?:ollama|lmstudio|lm_studio|oss)\b/i.test(text)) return true
  if (/(?:^|[\s=])(?:ollama|ollama_chat|lm_studio|lmstudio)\//i.test(text)) return true
  return words.some((w) => {
    const at = w.search(/https?:\/\//i)
    return at >= 0 && isLocalModelEndpoint(w.slice(at))
  })
}

/** 端末内・LAN の URL を指す、Agent の CLI が読む接続先の環境変数（Claude Code・Codex・Gemini CLI） */
const AGENT_BASE_URL_ENV: Partial<Record<string, readonly string[]>> = {
  claude: ['ANTHROPIC_BASE_URL'],
  codex: ['OPENAI_BASE_URL'],
  gemini: ['GOOGLE_GEMINI_BASE_URL', 'GEMINI_BASE_URL']
}

/**
 * その Agent が端末内・LAN のモデルで動いているか（上限での自動切り替えから外すため）。
 * 設定の起動（組み込みの launch・カスタムの command / args）と、Ferret が受け継いだ接続先の環境変数を見る
 */
export function agentUsesLocalModel(
  agent: TuiAgent,
  prefs: Pick<AgentPreferences, 'launch' | 'customAgents'> | null | undefined,
  env: Record<string, string | undefined> = {}
): boolean {
  const launch = isBuiltinAgent(agent) ? prefs?.launch?.[agent] : findCustomAgent(prefs, agent)
  if (launch && launchUsesLocalModel(launch.command, launch.args)) return true
  return (AGENT_BASE_URL_ENV[agent] ?? []).some((name) => isLocalModelEndpoint(env[name]))
}
