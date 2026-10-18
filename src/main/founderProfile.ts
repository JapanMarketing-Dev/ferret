import { readFile, rename, writeFile } from 'node:fs/promises'
import { FOUNDER_PROFILE_MAX } from '@shared/founderProfile'

/**
 * 使っている人の状況（@shared/founderProfile）の置き場。userData/founder-profile.md に1つ（ビジネスリサーチ・ビジネスのすべてで共通）。
 * 読めない・無いときは空。書くときは一時ファイル → rename
 */
export class FounderProfileStore {
  private cache: string | null = null

  constructor(private readonly file: string) {}

  async get(): Promise<string> {
    if (this.cache !== null) return this.cache
    this.cache = await readFile(this.file, 'utf8').then((text) => text.slice(0, FOUNDER_PROFILE_MAX), () => '')
    return this.cache
  }

  async set(text: unknown): Promise<string> {
    if (typeof text !== 'string') throw new TypeError('profile must be text')
    const value = text.replace(/\r\n?/g, '\n').slice(0, FOUNDER_PROFILE_MAX)
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, value, { mode: 0o600 })
    await rename(tmp, this.file)
    this.cache = value
    return value
  }
}
