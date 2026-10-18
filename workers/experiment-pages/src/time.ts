/** 日本時間（UTC+9）の日付 YYYY-MM-DD */
export function jstDay(now: Date): string {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10)
}

/** YYYY-MM-DD に日数を足す */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

/** UTC の時間帯キー YYYY-MM-DDTHH */
export function utcHour(now: Date): string {
  return now.toISOString().slice(0, 13)
}
