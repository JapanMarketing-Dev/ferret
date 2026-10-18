type Level = 'info' | 'warn' | 'error'

const EMAIL_LIKE = /[^\s@]+@[^\s@]+/g

function safeError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message.replace(EMAIL_LIKE, '[email]').slice(0, 300) }
  }
  return { name: 'NonError', message: '' }
}

/**
 * Workers Observability に載る構造化ログ。個人情報（メール・IP・本文）は渡さないこと。
 * err は名前とメッセージだけに絞る。
 */
export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const { err, ...rest } = fields
  const entry: Record<string, unknown> = { level, event, ...rest }
  if (err !== undefined) entry.error = safeError(err)
  const line = JSON.stringify(entry)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}
