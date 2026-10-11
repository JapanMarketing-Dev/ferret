/**
 * 所有者だけが読めるファイルの置き換え（一時ファイルに書いてから rename）。
 * 一時ファイルの名前は毎回ちがう（pid だけだと、同じプロセスの2つの保存が同じ一時ファイルに書き、片方の失敗の片付けがもう片方を消す）
 */
import { randomBytes } from 'node:crypto'
import { closeSync, constants, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import { mkdir, open as openAsync, rm as rmAsync } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/**
 * 所有者だけが読めるファイルを置き換える。一時ファイルは新しく作ったものだけに書き（O_EXCL）、リンクはたどらない（O_NOFOLLOW）。
 * rename は置き場所のリンクそのものを置き換えるので、リンクの先には書かない
 */
export function writePrivateFileAtomicSync(target: string, data: string | Uint8Array): void {
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600)
  try {
    try {
      if (typeof data === 'string') writeSync(fd, data)
      else writeSync(fd, data)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, target)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/**
 * writePrivateFileAtomicSync の非同期版（書き込みと fsync は main の処理を止めない）。作り方の決まりは同じ
 * （O_EXCL・O_NOFOLLOW・0600 の一時ファイルに書いてから rename）。
 * commit が false を返したら（書いている間に、より新しい書き込みや消去があった）置き換えずに一時ファイルを消す。
 * 確かめてから置き換えるまでは同期で行い（renameSync）、その間に同期の書き込み・消去が割り込まないようにする。置き換えたら true
 */
export async function writePrivateFileAtomic(target: string, data: string | Uint8Array, commit: () => boolean = () => true): Promise<boolean> {
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
  const handle = await openAsync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600)
  try {
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (!commit()) {
      await rmAsync(tmp, { force: true })
      return false
    }
    renameSync(tmp, target)
    return true
  } catch (err) {
    await rmAsync(tmp, { force: true })
    throw err
  }
}

/** フォルダが無ければ作ってから writePrivateFileAtomic で置き換える */
export async function savePrivateFile(target: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  await writePrivateFileAtomic(target, data)
}
