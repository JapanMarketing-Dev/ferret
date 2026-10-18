import { basename, join } from 'node:path'
import type { VideoIpcHandlers, VideoMainContext } from '../context'
import type { VideoRecordIpc } from '../../shared/ipc/record'
import type { RecordPrefs, RecordSetup } from '../../shared/record/types'
import type { RecordSession } from './session'

/**
 * 撮影（担当: 撮影）。録画ウインドウ・書き込み・設定（zod）は重いので、撮影の画面を初めて開いたときに読み込む（起動時間 NF-5）。
 *
 * セキュリティの約束（Ferret の録画と同じ）:
 * - 画面・カメラを開くのは非表示の録画ウインドウだけ。アプリの窓へは縮小フレームと音の大きさだけ
 * - 録画の開始・画面の一覧（サムネイル）は利用者の操作の直後だけ（ctx.consumeGesture）
 * - 書くのは今のチャンネルの中の動画のフォルダの media/takes/ だけ
 * - Ferret のレビューの録画とは同時に使わない（ctx.reviewRecording・captureLock）
 */

/** 動画の録画ウインドウのページと preload。配布版の out/ は app.asar の中（video-cli だけが unpacked） */
export function recorderAssets(appOutDir: string): { html: string; region: string; preload: string } {
  const out = appOutDir.replace(/app\.asar\.unpacked(?=[\\/]|$)/, 'app.asar')
  return { html: join(out, 'video-recorder', 'index.html'), region: join(out, 'video-recorder', 'region.html'), preload: join(out, 'preload', 'videoRecorder.js') }
}

/** CLI の ingest の結果を、画面に出す1行にする */
export function ingestMessage(result: { code: number; stdout: string; stderr: string }): { ok: boolean; message: string } {
  const pick = (s: string) => s.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('{"progress"')).pop() ?? ''
  return result.code === 0 ? { ok: true, message: pick(result.stdout) } : { ok: false, message: pick(result.stderr) || pick(result.stdout) || `exit ${result.code}` }
}

type Settings = Awaited<ReturnType<typeof import('@video/settings')['loadSettings']>>

export function prefsFromSettings(s: Settings): RecordPrefs {
  return {
    screenFps: s.recording.screen.fps,
    camera: { deviceId: s.recording.camera.deviceId, width: s.recording.camera.width, height: s.recording.camera.height, fps: s.recording.camera.fps },
    micId: s.recording.mic.deviceId,
    systemAudio: s.recording.systemAudio,
    region: s.record.region ?? null,
    autoStart: s.autopilot.autoStart,
    hotkeys: { ng: s.recording.hotkeys.markNg, important: s.recording.hotkeys.markImportant }
  }
}

export function recordHandlers(ctx: VideoMainContext): VideoIpcHandlers<VideoRecordIpc> {
  let session: Promise<RecordSession> | null = null
  const getSession = (): Promise<RecordSession> => (session ??= createSession(ctx).catch((err: unknown) => { session = null; throw err }))
  const settings = () => import('@video/settings')

  return {
    'video:record:setup': async (): Promise<RecordSetup> => {
      const s = await getSession()
      const [{ loadSettings }, { listDisplays }, devices] = await Promise.all([settings(), import('./regionPicker'), s.prepare()])
      const { systemAudioUnsupported } = await import('@shared/systemAudio')
      return {
        platform: process.platform,
        displays: listDisplays(),
        devices,
        prefs: prefsFromSettings(loadSettings()),
        status: s.current,
        systemAudioSupported: systemAudioUnsupported(process.platform, typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '') === null,
        blocked: ctx.reviewRecording?.() ? 'reviewRecording' : null
      }
    },
    'video:record:sources': async () => {
      const { userError } = await import('./session')
      if (!(ctx.consumeGesture?.('sources') ?? false)) throw userError('video.record.errors.needsUserAction')
      const { listCaptureSources, screenAccess } = await import('../../../../main/recording/sources')
      const sources = await listCaptureSources().catch((err: unknown) => {
        ctx.reportHandled(err, { area: 'video', op: 'list capture sources' })
        return []
      })
      return { screenAccess: screenAccess(), sources }
    },
    'video:record:preview': async (selection) => (await getSession()).preview(selection),
    'video:record:pickRegion': async (displayId) => {
      const { userError } = await import('./session')
      if (typeof displayId !== 'string' || !/^\d{1,20}$/.test(displayId)) throw userError('video.record.errors.regionDisplayMissing')
      if ((await getSession()).current.state !== 'idle') throw userError('video.record.errors.busy')
      const [{ pickRegion }, { setSetting }, { t }] = await Promise.all([import('./regionPicker'), settings(), import('@shared/i18n')])
      const assets = recorderAssets(ctx.appOutDir)
      let region
      try {
        region = await pickRegion(displayId, { htmlPath: assets.region, preloadPath: assets.preload }, t('video.record.regionHint'))
      } catch (err) {
        ctx.reportHandled(err, { area: 'video', op: 'pick region' })
        throw userError('video.record.errors.regionDisplayMissing')
      }
      if (region) setSetting('record.region', region, { by: 'app' })
      return region
    },
    'video:record:clearRegion': async () => {
      ;(await settings()).setSetting('record.region', null, { by: 'app' })
    },
    'video:record:savePrefs': async (prefs) => {
      const { loadSettings, applySetting, saveSettings } = await settings()
      const { cleanCameraFormat, cleanFps } = await import('../../shared/record/plan')
      let next = loadSettings()
      const p = (prefs && typeof prefs === 'object' ? prefs : {}) as Partial<RecordPrefs>
      if (p.screenFps !== undefined) next = applySetting(next, 'recording.screen.fps', cleanFps(p.screenFps, next.recording.screen.fps))
      if (p.camera && typeof p.camera === 'object') {
        const format = cleanCameraFormat(p.camera)
        next = applySetting(next, 'recording.camera', {
          deviceId: typeof p.camera.deviceId === 'string' && p.camera.deviceId.length <= 500 ? p.camera.deviceId : next.recording.camera.deviceId, ...format
        })
      }
      if (typeof p.micId === 'string' && p.micId.length <= 500) next = applySetting(next, 'recording.mic.deviceId', p.micId)
      if (typeof p.systemAudio === 'boolean') next = applySetting(next, 'recording.systemAudio', p.systemAudio)
      saveSettings(next, { by: 'app' })
      return prefsFromSettings(next)
    },
    'video:record:start': async (plan) => (await getSession()).start(plan),
    'video:record:stop': async () => (await getSession()).stop(),
    'video:record:mark': async (kind) => (await getSession()).mark(kind),
    'video:record:status': async () => (session ? (await session).current : { state: 'idle', markers: { ng: 0, important: 0 }, bytes: 0, tracks: 0 }),
    'video:record:close': async () => {
      if (session) (await session).close()
    }
  }
}

async function createSession(ctx: VideoMainContext): Promise<RecordSession> {
  const [{ RecordSession, userError }, { TakeWriter }, { CursorLog }, { VideoRecorderWindow }, { listDisplays }, electron, videos, cli, settingsMod] = await Promise.all([
    import('./session'), import('./takeWriter'), import('./cursor'), import('./recorderWindow'), import('./regionPicker'),
    import('electron'), import('../library/videos'), import('../cli/run'), import('@video/settings')
  ])
  const { app, globalShortcut, screen } = electron
  const assets = recorderAssets(ctx.appOutDir)
  const { systemAudioUnsupported } = await import('@shared/systemAudio')
  let hotkeys = prefsFromSettings(settingsMod.loadSettings()).hotkeys
  const session = new RecordSession({
    createLink: (handlers) => new VideoRecorderWindow(assets.html, assets.preload, handlers),
    writer: new TakeWriter(),
    cursor: new CursorLog(screen),
    listSources: async () => {
      const { listCaptureSources } = await import('../../../../main/recording/sources')
      return (await listCaptureSources({ width: 0, height: 0 })).map((s) => ({ id: s.id, kind: s.kind, ...(s.displayId ? { displayId: s.displayId } : {}) }))
    },
    displays: listDisplays,
    systemAudioSupported: () => systemAudioUnsupported(process.platform, typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '') === null,
    reviewRecording: () => ctx.reviewRecording?.() ?? false,
    // 操作の許可を確かめられないときは始めない
    consumeGesture: (action) => ctx.consumeGesture?.(action) ?? false,
    resolveVideoDir: (dir) => {
      if (typeof dir !== 'string' || !dir) throw userError('video.record.errors.videoDirInvalid')
      try {
        return videos.resolveVideoDir(ctx.folderPath(), basename(dir))
      } catch {
        throw userError('video.record.errors.videoDirInvalid')
      }
    },
    runIngest: async (videoDir) => ingestMessage(await cli.runVideoCli(['ingest'], { cwd: videoDir })),
    region: () => settingsMod.loadSettings().record.region,
    autoStart: () => settingsMod.loadSettings().autopilot.autoStart,
    get hotkeys() {
      // 録画を始めるたびに、そのときの設定を読む
      try { hotkeys = prefsFromSettings(settingsMod.loadSettings()).hotkeys } catch { /* 最後に読めた値 */ }
      return hotkeys
    },
    registerHotkey: (accel, fn) => globalShortcut.register(accel, fn),
    unregisterHotkey: (accel) => globalShortcut.unregister(accel),
    emitStatus: (status) => ctx.send('video:record:status', status),
    emitLevels: (levels) => ctx.send('video:record:levels', levels),
    emitFrame: (frame) => ctx.send('video:record:frame', frame),
    emitDevices: (devices) => ctx.send('video:record:devices', devices),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
    app: { version: app.getVersion(), os: process.platform },
    report: (err, op) => ctx.reportHandled(err, { area: 'video', op })
  })
  app.on('will-quit', () => session.dispose())
  return session
}
