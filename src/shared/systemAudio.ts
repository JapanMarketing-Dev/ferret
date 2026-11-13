/**
 * 相手の声（PC の音声・ループバック。AUD-1）を録るときの OS ごとの決まり。
 * main（録画の開始・Chromium の機能の切り替え）と録画ウインドウ（失敗の言い分け）の両方から使う。
 * Electron に依存させない（単体テストで確かめるため）。
 *
 * - macOS: 14.2 以降。Core Audio の tap（Chromium の MacCatapLoopbackAudioForScreenShare）で録る。
 *   初回に OS が「画面とシステムオーディオの録音」の許可を求める。画面そのものは録らない
 * - Windows: 許可は要らない。再生デバイス（スピーカー・ヘッドホン）の音をそのまま録る
 * - Linux: PulseAudio（PipeWire なら pipewire-pulse）のモニターから録る（PulseaudioLoopbackForScreenShare）
 */

type SystemAudioPlatform = 'darwin' | 'win32' | 'linux' | (string & {})

/** 録れないと分かっている理由。null なら試してよい */
type SystemAudioUnsupported = 'macosTooOld' | null

/** 録れなかったときの言い分け。文は main が画面の言語で用意する */
type SystemAudioFailure = 'denied' | 'noDevice' | 'failed'

/** macOS で録れる最小の版（Core Audio の tap が使えるのは 14.2 から） */
const MAC_MIN_VERSION: readonly [number, number] = [14, 2]

/** この OS・版で相手の声を録れるか。版が読めないときは試す（止めない） */
export function systemAudioUnsupported(platform: SystemAudioPlatform, osVersion: string): SystemAudioUnsupported {
  if (platform !== 'darwin') return null
  const [major, minor] = osVersion.split('.').map((part) => Number.parseInt(part, 10))
  if (!Number.isFinite(major)) return null
  const [needMajor, needMinor] = MAC_MIN_VERSION
  if ((major as number) < needMajor || ((major as number) === needMajor && (Number.isFinite(minor) ? (minor as number) : 0) < needMinor)) return 'macosTooOld'
  return null
}

/** 起動時に Chromium へ足す機能（--enable-features）。PC の音声をループバックで取れるようにする */
export function systemAudioFeatures(platform: SystemAudioPlatform): string[] {
  if (platform === 'darwin') return ['MacCatapLoopbackAudioForScreenShare']
  if (platform === 'linux') return ['PulseaudioLoopbackForScreenShare']
  return []
}

/**
 * getDisplayMedia / getUserMedia の失敗（DOMException の name）を言い分ける。
 * macOS は許可が無いと取り込みを始められず、AbortError（Electron が取り込みを断った）や NotReadableError（音声を開けない）になる。
 * macOS ではいちばん多い原因の「許可」を案内する
 */
export function classifySystemAudioError(name: string | undefined, platform?: SystemAudioPlatform): SystemAudioFailure {
  if (platform === 'darwin' && (name === 'AbortError' || name === 'NotReadableError')) return 'denied'
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'denied'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'noDevice'
    default:
      return 'failed'
  }
}

/**
 * 検証用（ADE_SYNTHETIC_MIC=1 の起動）。会議アプリや OS の許可なしで、相手の声の経路を通す。
 * - page: 内蔵ブラウザのページが鳴らす音を、PC の音声の代わりに録る（OS の許可は要らない）
 * - denied: OS が許可しなかったときと同じく、取り込みを断る
 * - no-device: 音声の出力先が無いときと同じく、音声の無い取り込みを返す
 * - ends: page と同じに録り始め、途中で取り込みが止まる（出力先が抜かれたときと同じ）
 */
export type SyntheticSystemAudio = 'page' | 'denied' | 'no-device' | 'ends'
