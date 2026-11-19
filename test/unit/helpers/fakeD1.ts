import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { D1Database, D1PreparedStatement, D1Result, D1Value } from '../../../workers/feedback-cloud/src/env'

/**
 * D1 の偽物。Node の node:sqlite（メモリ上の SQLite）で本物の SQL を流す。
 * migration の SQL をそのまま流して表を作るので、Worker の SQL の誤りもテストで見つかる。
 * batch は1つのトランザクション（D1 と同じく、途中で失敗すれば全部が戻る）。
 */
export function fakeD1(migrationPaths: string[]): D1Database & { db: DatabaseSync } {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  for (const p of migrationPaths) db.exec(readFileSync(p, 'utf8'))

  const returnsRows = (sql: string) => /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)

  function execute(sql: string, params: D1Value[]): D1Result {
    for (const v of params) {
      // D1 は undefined を受けない（null で渡す）
      if (v === undefined) throw new Error('D1_TYPE_ERROR: undefined is not supported')
    }
    const stmt = db.prepare(sql)
    if (returnsRows(sql)) {
      const rows = stmt.all(...params) as Record<string, unknown>[]
      return { results: rows.map((r) => ({ ...r })), meta: { changes: /\bRETURNING\b/i.test(sql) ? rows.length : 0 } }
    }
    const info = stmt.run(...params)
    return { results: [], meta: { changes: Number(info.changes) } }
  }

  class Statement implements D1PreparedStatement {
    constructor(readonly sql: string, readonly params: D1Value[] = []) {}
    bind(...values: D1Value[]): D1PreparedStatement {
      return new Statement(this.sql, values)
    }
    async first<T>(): Promise<T | null> {
      return (execute(this.sql, this.params).results[0] as T | undefined) ?? null
    }
    async all<T>(): Promise<D1Result<T>> {
      return execute(this.sql, this.params) as D1Result<T>
    }
    async run(): Promise<D1Result> {
      return execute(this.sql, this.params)
    }
  }

  return {
    db,
    prepare: (sql) => new Statement(sql),
    async batch(statements) {
      db.exec('BEGIN')
      try {
        const out = statements.map((s) => execute((s as Statement).sql, (s as Statement).params))
        db.exec('COMMIT')
        return out
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    }
  }
}
