import type { FsChangedEvent } from '@shared/files'

/**
 * 開いているファイルへの外部の変更（Agent の書き換えなど）の取り込みの決まり（純粋関数。useOpenFiles が使う）。
 *
 * 取り込みが遅れる・開き直すまで古いままになっていた原因と、ここでの手当て:
 *   - 読み直しの答えが前後すると、古い内容が後から上書きして、そのまま次の通知が来ない → 最後に頼んだ読み直しだけを使う（LatestRequests）
 *   - 開いて読んでいる途中に届いた通知を捨てていた → 読み直す
 *   - 通知が多すぎる（ビルド・別の worktree の書き込み）と main が捨てた分に開いているファイルが入る → overflow なら全部確かめる
 *   - 日本語の名前は、監視の通知と一覧で正規化（NFC / NFD）が違うことがある → NFC で比べる
 *   - 監視の外（.ferret など）・監視が止まったとき → 開いているタブはディスクの日時と大きさを時々見る（diskStampChanged）
 */

export interface OpenFileRef {
  id: string
  root: string
  path: string
}

function nfc(path: string): string {
  return path.normalize('NFC')
}

/** 通知で確かめ直す、開いているファイル（今のプロジェクトのものだけ） */
export function filesToRecheck<T extends OpenFileRef>(files: readonly T[], root: string | null, event: FsChangedEvent): T[] {
  const mine = files.filter((f) => f.root === root)
  if (event.overflow) return mine
  const changed = new Set(event.paths.map(nfc))
  return mine.filter((f) => changed.has(nfc(f.path)))
}

export type ExternalDecision =
  /** 何もしない（自分の保存の通知など、中身が同じ） */
  | { kind: 'none' }
  /** 消えた・変わったと出していたが、ディスクが最後に見た内容に戻った（知らせを下ろす） */
  | { kind: 'restored' }
  /** 未保存の変更が無い。ディスクの内容に差し替える */
  | { kind: 'reload' }
  /** 未保存の変更と同じ内容になった（同じ直しが書かれた）。保存済みにする */
  | { kind: 'adopt' }
  /** 未保存の変更がある。上書きせずに知らせる */
  | { kind: 'conflict' }

/**
 * 読み直した内容をどう扱うか。dirty は state ではなく drafts（今の編集）と saved の差で決める
 * （state の dirty は描画の後に変わるので、打ってすぐの通知で取り込んで編集を消さない）
 */
export function decideExternalChange(state: { saved: string; draft: string | undefined; external?: 'changed' | 'deleted' }, disk: string): ExternalDecision {
  const current = state.draft ?? state.saved
  if (disk === state.saved) return state.external ? { kind: 'restored' } : { kind: 'none' }
  if (current === state.saved) return { kind: 'reload' }
  if (current === disk) return { kind: 'adopt' }
  return { kind: 'conflict' }
}

export interface DiskStamp {
  mtimeMs: number
  size: number
}

/** ディスクの日時か大きさが、最後に読んだ・書いたときと違うか。最後が分からなければ違うとみなす（中身で確かめる） */
export function diskStampChanged(last: DiskStamp | undefined, now: DiskStamp): boolean {
  return !last || last.mtimeMs !== now.mtimeMs || last.size !== now.size
}

/**
 * ファイルごとに「最後に頼んだ読み込み」だけを生かす。前の読み込みの答えが後から届いても捨てる
 */
export class LatestRequests {
  private seq = new Map<string, number>()
  /** 全部のファイルで通しの番号（閉じて開き直したファイルで、前の番号と重ならない） */
  private counter = 0

  begin(id: string): number {
    this.counter += 1
    this.seq.set(id, this.counter)
    return this.counter
  }

  isLatest(id: string, ticket: number): boolean {
    return this.seq.get(id) === ticket
  }

  forget(id: string): void {
    this.seq.delete(id)
  }
}
