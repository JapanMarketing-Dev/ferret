/**
 * 録画中のマイクの付け替え（録画ウインドウ src/recorder/recorder.ts が使う）。
 *
 * 録画中にマイクが抜かれた・OS の既定のマイクが変わった（AirPods をつないだ等）・マイクの取り込みが終わった（ended）ときも、
 * 録画は止めない。映像はそのまま続け、マイクだけを開き直して同じ音声の系統へつなぎ直す。
 * 開けるマイクが無い間は映像だけ録り、マイクが戻ったら（devicechange）つなぎ直す。
 *
 * Electron・DOM に依存しない純粋な処理だけを置く（単体テストで確かめる）。
 */

export interface MicDeviceLike {
  deviceId: string
  label: string
  groupId?: string
}

/** いま開いているマイク */
export interface OpenMic {
  /** 開くときに指定した ID（'' は OS の既定） */
  requested: string
  /** 開いたときの既定のマイク（defaultMicKey）。既定を開いたときだけ意味がある */
  defaultKey: string | null
  /** 取り込みが続いているか（track.readyState === 'live'） */
  live: boolean
}

export type MicRecoveryAction =
  /** そのまま */
  | { kind: 'keep' }
  /** 開き直す（'' は OS の既定） */
  | { kind: 'open'; deviceId: string }
  /** 開けるマイクが無い。映像だけ続け、次の devicechange を待つ */
  | { kind: 'wait' }

/**
 * OS の既定のマイクを見分ける印。Chromium の一覧の 'default' の項目（グループ ID・名前）。
 * 'default' が無い環境（Windows の一部など）は最初のマイク。マイクが1つも無ければ null
 */
export function defaultMicKey(devices: readonly MicDeviceLike[]): string | null {
  const entry = devices.find((d) => d.deviceId === 'default') ?? devices.find((d) => d.deviceId !== 'communications')
  if (!entry) return null
  return `${entry.groupId ?? ''}|${entry.label}`
}

/**
 * マイクの一覧が変わった・取り込みが終わったときに、どうするか。
 *
 * @param wanted 設定で選んだマイク（'' は OS の既定）。選んだマイクが無ければ既定へ切り替え、戻ってきたら選んだものへ戻す
 * @param open いま開いているマイク（開けていなければ null）
 * @param devices いまのマイクの一覧（audioinput だけ）
 */
export function micRecoveryAction(wanted: string, open: OpenMic | null, devices: readonly MicDeviceLike[]): MicRecoveryAction {
  // 'default' を選んだ値として持っていても、OS の既定と同じに扱う
  const want = wanted === 'default' ? '' : wanted
  const usable = devices.filter((d) => d.deviceId !== '')
  if (usable.length === 0) return open?.live ? { kind: 'keep' } : { kind: 'wait' }
  const target = want && usable.some((d) => d.deviceId === want) ? want : ''
  if (!open || !open.live) return { kind: 'open', deviceId: target }
  if (open.requested !== target) return { kind: 'open', deviceId: target }
  // 既定を開いているとき、OS の既定が別のマイクに変わったら、新しい既定を開き直す（Chromium は開いたマイクのままになる）
  if (target === '' && open.defaultKey !== defaultMicKey(usable)) return { kind: 'open', deviceId: '' }
  return { kind: 'keep' }
}

/**
 * つなぎ直すまでの途切れを埋める無音のサンプル数。
 * main は最初の塊の時刻から、届いたサンプル数で時刻を数える（src/main/index.ts の createAudioWriter）。
 * 途切れた分を無音で埋めないと、つなぎ直したあとの声が早い時刻にずれる。
 *
 * @param activeMs 録画を始めてからの時間（一時停止していた間を除く）
 * @param startOffsetMs この系統が録り始めた時刻（録画開始から）
 * @param samplesSent これまでに送ったサンプル数
 */
export function silencePadSamples(activeMs: number, startOffsetMs: number, samplesSent: number, sampleRate: number): number {
  if (![activeMs, startOffsetMs, samplesSent, sampleRate].every(Number.isFinite) || sampleRate <= 0) return 0
  const expected = Math.floor(((activeMs - startOffsetMs) / 1000) * sampleRate)
  // 1時間を超える埋めは時計の狂いとみなして埋めない（巨大な無音を送らない）
  return Math.max(0, Math.min(expected - samplesSent, sampleRate * 3600))
}
