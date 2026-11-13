import { BrowserWindow, desktopCapturer, nativeImage, screen, shell, systemPreferences } from 'electron'
import type { CaptureSourceInfo, CaptureSourceList } from '@shared/types'
import { t } from '@shared/i18n'
import { reportHandled } from '@shared/report'
import { windowNumberOf, withAppWindows } from '@shared/desktopApps'
import { displayIdOfScreen, sortScreensByDisplay, withMissingDisplays } from '@shared/captureSources'
import { screenSourceForDisplay } from '@shared/quickCapture'
import { captureMacWindowImage, listMacWindows } from './devices'

/**
 * 画面全体・別のウインドウの録画対象（REC-2 の拡張 / 設計9章）。
 *
 * desktopCapturer で候補を列挙し、選択画面用にサムネイルを付ける。
 * 内蔵ブラウザのタブ録画と違い、macOS では「画面収録」の許可が要る。
 * 許可が無いと、候補は自アプリのウインドウと壁紙だけの画面になり、録画の映像も空になる。
 */

/**
 * 画面収録の許可。確認するのは macOS だけで、Windows・Linux（X11 / Wayland）は常に 'granted'。
 * Orca由来: ~/bench/orca/src/main/browser/browser-media-access.ts の hasSystemMediaAccess（MIT）。
 * Orca はマイク・カメラを見ているが、同じ考え方で 'screen' を見る。
 */
export function screenAccess(): CaptureSourceList['screenAccess'] {
  if (process.platform !== 'darwin') return 'granted'
  try {
    return systemPreferences.getMediaAccessStatus('screen')
  } catch (err) {
    reportHandled(err, { area: 'recording', op: 'read screen access' })
    return 'unknown'
  }
}

/**
 * システム設定の「画面収録」を開く。
 * Orca由来: ~/bench/orca/src/main/ipc/developer-permissions.ts の screen の URL（MIT）。
 *
 * 画面収録の許可が要るのは macOS だけ。Windows は許可が要らず、Linux は X11 ならそのまま、
 * Wayland なら録画を始めるときに OS（PipeWire のポータル）が選択ダイアログを出す。
 * どちらも開く設定が無いので何もしない（screenAccess が 'granted' を返すので案内も出ない）。
 */
export async function openScreenSettings(): Promise<void> {
  if (process.platform !== 'darwin') return
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
}

/**
 * 録画できる画面・ウインドウの一覧。
 *
 * 自アプリのウインドウ（Ferret 本体・録画用の非表示ウインドウ）は出さない。
 * 内蔵ブラウザを録るなら「内蔵ブラウザ」を選べばよく、本体を録ると自分の録画ピルまで写るため。
 * 除くのは自分の BrowserWindow の ID と自分のプロセスのウインドウだけ。同じ Electron で動く開発中のアプリは出す。
 *
 * macOS では、desktopCapturer が出さない常に手前のウインドウ（alwaysOnTop・パネル）を足し、各ウインドウにアプリ名を付ける
 * （@shared/desktopApps の withAppWindows）。足したウインドウは desktopCapturer がサムネイルを作らないので、screencapture で撮って付ける。
 *
 * 画面は、つないでいるディスプレイ（screen.getAllDisplays）と突き合わせ、一覧に無いディスプレイを足す（macOS。@shared/captureSources）。
 * macOS の一覧に出るのは、いま表示しているデスクトップ（Spaces）のウインドウだけ。ほかのデスクトップ・しまったウインドウは出ない（OS の制約）。
 *
 * @param thumbnail サムネイルの大きさ。0×0 なら作らない（録画開始時の存在確認用。速い）
 */
export async function listCaptureSources(
  thumbnail: { width: number; height: number } = { width: 320, height: 200 }
): Promise<CaptureSourceInfo[]> {
  const own = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()))
  const withThumbnail = thumbnail.width > 0 && thumbnail.height > 0
  // ウインドウの題名・アプリ名は画面収録の許可があるときだけ読める。許可が無ければ読まない
  const [sources, macWindows] = await Promise.all([
    desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: thumbnail,
      fetchWindowIcons: withThumbnail
    }),
    screenAccess() === 'granted' ? listMacWindows().catch((err: unknown) => { reportHandled(err, { area: 'recording', op: 'list mac windows' }); return [] }) : Promise.resolve([])
  ])
  const displays = screen.getAllDisplays()
  const primaryId = String(screen.getPrimaryDisplay().id)

  const listed = sources
    .filter((source) => !own.has(source.id))
    .map((source): CaptureSourceInfo => {
      const kind = source.id.startsWith('screen:') ? 'screen' : 'window'
      const displayId = kind === 'screen' ? displayIdOfScreen(source.id, source.display_id || undefined, process.platform) : source.display_id || undefined
      return {
        id: source.id,
        kind,
        name: kind === 'screen' ? screenName(displayId, displays, primaryId, source.name) : source.name || t('recording.source.untitledWindow'),
        ...(displayId ? { displayId } : {}),
        thumbnail: withThumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : '',
        ...(source.appIcon && !source.appIcon.isEmpty() ? { appIcon: source.appIcon.toDataURL() } : {})
      }
    })
  // 一覧に無いディスプレイを足し（macOS）、「画面 1」「画面 2」の番号の順に並べる
  const fallbackName = t('recording.source.screen')
  const screens = sortScreensByDisplay(withMissingDisplays(listed, displays, process.platform, fallbackName), displays)
    .map((source) => (source.kind === 'screen' && source.name === fallbackName ? { ...source, name: screenName(source.displayId, displays, primaryId, fallbackName) } : source))
  const all = withAppWindows(screens, macWindows, process.pid)
  if (!withThumbnail) return all
  return Promise.all(all.map(async (source) => {
    if (source.thumbnail || source.kind !== 'window') return source
    const id = windowNumberOf(source.id)
    const image = id !== null ? await captureMacWindowImage(id).catch((err: unknown) => { reportHandled(err, { area: 'recording', op: 'window thumbnail' }); return null }) : null
    if (!image) return source
    const picture = nativeImage.createFromBuffer(image)
    if (picture.isEmpty()) return source
    const size = picture.getSize()
    const scale = Math.min(thumbnail.width / size.width, thumbnail.height / size.height, 1)
    const fitted = scale < 1 ? picture.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' }) : picture
    return { ...source, thumbnail: fitted.toDataURL() }
  }))
}

/** 画面の名前。OSの名前（Entire Screen など）は区別が付かないので、番号と大きさにする */
function screenName(displayId: string | undefined, displays: Electron.Display[], primaryId: string, fallback: string): string {
  const index = displays.findIndex((d) => String(d.id) === displayId)
  if (index < 0) return fallback || t('recording.source.screen')
  const display = displays[index]!
  const params = { n: index + 1, width: display.size.width, height: display.size.height }
  return String(display.id) === primaryId ? t('recording.source.screenNumberedMain', params) : t('recording.source.screenNumbered', params)
}

/**
 * ワンクリック録画の対象。その窓（Ferret）があるディスプレイの「画面全体」。窓が無ければ主ディスプレイ。
 * 画面が1つも見つからなければ null
 */
export async function screenSourceOfWindow(window: BrowserWindow | null): Promise<CaptureSourceInfo | null> {
  const display = window && !window.isDestroyed() ? screen.getDisplayMatching(window.getBounds()) : screen.getPrimaryDisplay()
  const sources = await listCaptureSources({ width: 0, height: 0 })
  return screenSourceForDisplay(sources, String(display.id))
}
