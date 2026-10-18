import { INTEREST_LIMITS } from './contract'

export interface InterestForm {
  name: string
  company: string
  email: string
  message: string
}

export type InterestParse =
  | { kind: 'ok'; value: InterestForm }
  | { kind: 'honeypot' }
  | { kind: 'invalid'; messages: string[] }

// 改行・タブ以外の制御文字と双方向制御文字
// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字の検出が目的
const FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/
// 1 行の項目では改行も禁止
// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字の検出が目的
const FORBIDDEN_SINGLE_LINE = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/

const EMAIL =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

export function isValidEmail(email: string): boolean {
  if (email.length > INTEREST_LIMITS.email) return false
  if (!EMAIL.test(email)) return false
  const local = email.slice(0, email.lastIndexOf('@'))
  return !local.startsWith('.') && !local.endsWith('.') && !local.includes('..')
}

const FIELDS = ['name', 'company', 'email', 'message', 'consent', 'website'] as const

/** 関心表明フォームの検証。入力値はエラーメッセージに含めない。 */
export function parseInterestForm(params: URLSearchParams): InterestParse {
  const messages: string[] = []
  for (const f of FIELDS) {
    if (params.getAll(f).length > 1) messages.push('同じ項目が重複しています')
  }
  if (messages.length > 0) return { kind: 'invalid', messages: [...new Set(messages)] }

  // ボット対策の見えない欄。入っていたら受け付けたふりをして捨てる。
  if ((params.get('website') ?? '') !== '') return { kind: 'honeypot' }

  const name = (params.get('name') ?? '').trim()
  const company = (params.get('company') ?? '').trim()
  const email = (params.get('email') ?? '').trim()
  const message = (params.get('message') ?? '').replace(/\r\n?/g, '\n').trim()
  const consent = params.get('consent')

  if ([...name].length > INTEREST_LIMITS.name) messages.push(`お名前は${INTEREST_LIMITS.name}文字以内にしてください`)
  if ([...company].length > INTEREST_LIMITS.company)
    messages.push(`会社名は${INTEREST_LIMITS.company}文字以内にしてください`)
  if (FORBIDDEN_SINGLE_LINE.test(name) || FORBIDDEN_SINGLE_LINE.test(company) || FORBIDDEN_SINGLE_LINE.test(email))
    messages.push('使えない文字が含まれています')
  if (email === '') messages.push('メールアドレスを入力してください')
  else if (!isValidEmail(email)) messages.push('メールアドレスの形式が正しくありません')
  if ([...message].length > INTEREST_LIMITS.message)
    messages.push(`ご質問・ご要望は${INTEREST_LIMITS.message}文字以内にしてください`)
  if (FORBIDDEN.test(message)) messages.push('使えない文字が含まれています')
  if (consent !== 'yes') messages.push('同意の確認が必要です')

  if (messages.length > 0) return { kind: 'invalid', messages: [...new Set(messages)] }
  return { kind: 'ok', value: { name, company, email, message } }
}
