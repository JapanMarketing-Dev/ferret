/**
 * 足元のアカウントの内訳で、同じログインの行を1つにする（同じアカウントを2回追加した・システムの既定も同じログイン）
 */
import { describe, expect, it } from 'vitest'
import { dedupeAccountRows } from '../../src/shared/accounts'

const row = (accountId: string | null, email: string | null, workspaceLabel: string | null = null) => ({ accountId, email, workspaceLabel })

describe('同じログインの行をまとめる', () => {
  it('システムの既定と同じメールを2回追加しても、選択中の1行だけ残す。ほかのアカウントはそのまま', () => {
    const rows = [row(null, 'a@example.com'), row('x', 'a@example.com'), row('y', 'A@Example.com '), row('z', 'b@example.com')]
    expect(dedupeAccountRows(rows, 'y').map((r) => r.accountId)).toEqual(['y', 'z'])
  })

  it('選択中が無い（システムの既定を使っている）ならシステムの既定を残す', () => {
    const rows = [row(null, 'a@example.com'), row('x', 'a@example.com'), row('z', 'b@example.com')]
    expect(dedupeAccountRows(rows, null).map((r) => r.accountId)).toEqual([null, 'z'])
  })

  it('同じメールでも組織が違えば別の行。メールが分からない行はまとめない', () => {
    const rows = [row(null, null), row('x', 'a@example.com', 'Acme'), row('y', 'a@example.com', 'Personal'), row('w', null)]
    expect(dedupeAccountRows(rows, null).map((r) => r.accountId)).toEqual([null, 'x', 'y', 'w'])
  })
})

import { duplicateAccountIds } from '../../src/shared/accounts'

const acc = (id: string, email: string | null, createdAt: number, signedIn = true, workspaceLabel: string | null = null, fresh = true) => ({ id, email, workspaceLabel, createdAt, signedIn, fresh })
const old = (id: string, email: string | null, createdAt: number) => acc(id, email, createdAt, true, null, false)
const system = (email: string | null) => ({ signedIn: !!email, email, workspaceLabel: null })

describe('同じログインを2つ登録しない', () => {
  it('同じメールを2回追加したら、後から追加したものを外す', () => {
    expect(duplicateAccountIds([acc('a', 'x@example.com', 1), acc('b', 'X@example.com', 2), acc('c', 'y@example.com', 3)], null, system(null))).toEqual(['b'])
  })

  it('追加したばかりのものどうしは、選択中のものを残し、ほかを外す', () => {
    expect(duplicateAccountIds([acc('a', 'x@example.com', 1), acc('b', 'x@example.com', 2)], 'b', system(null))).toEqual(['a'])
  })

  it('システムの既定と同じログインを追加したら、追加したほうを外す', () => {
    expect(duplicateAccountIds([acc('a', 'x@example.com', 1), acc('b', 'x@example.com', 2), acc('g', 'g@example.com', 3)], null, system('x@example.com'))).toEqual(['a', 'b'])
    expect(duplicateAccountIds([acc('b', 'x@example.com', 2)], 'b', system('x@example.com'))).toEqual(['b'])
  })

  it('ログイン待ち・メールが分からない・組織が違うものは外さない', () => {
    expect(duplicateAccountIds([
      acc('a', 'x@example.com', 1, true, 'Acme'),
      acc('b', 'x@example.com', 2, true, 'Personal'),
      acc('c', 'x@example.com', 3, false, 'Acme'),
      acc('d', null, 4)
    ], null, system(null))).toEqual([])
  })
})

describe('前から使っているアカウントは決して外さない（2026-10-10 の消失）', () => {
  it('同じログインを追加して選択中にしても、前からあるほうは外さず、追加したほうを外す', () => {
    expect(duplicateAccountIds([old('a', 'x@example.com', 1), acc('b', 'x@example.com', 2)], 'b', system(null))).toEqual(['b'])
  })

  it('システムの既定と同じログインでも、選択中でなくても、前からあるものは外さない', () => {
    expect(duplicateAccountIds([old('a', 'x@example.com', 1), acc('b', 'x@example.com', 2)], null, system('x@example.com'))).toEqual(['b'])
    expect(duplicateAccountIds([old('a', 'x@example.com', 1)], null, system('x@example.com'))).toEqual([])
  })

  it('前からあるものどうしが同じログインになっても（タブの中で /login し直した）どちらも外さない', () => {
    expect(duplicateAccountIds([old('a', 'x@example.com', 1), old('b', 'x@example.com', 2)], 'b', system('x@example.com'))).toEqual([])
    expect(duplicateAccountIds([old('a', 'x@example.com', 1), old('b', 'X@Example.com', 2)], null, system(null))).toEqual([])
  })

  it('別のログインを追加しても何も外さない', () => {
    expect(duplicateAccountIds([old('a', 'x@example.com', 1), acc('b', 'y@example.com', 2)], 'b', system('z@example.com'))).toEqual([])
  })
})

import { defaultLoginLabel } from '../../src/shared/accounts'
import { setLocale } from '../../src/shared/i18n'
import { sanitizeAgentAccounts } from '../../src/main/accounts/sanitize'

describe('いつものログインの表示名（「システムの既定」という別枠を出さない）', () => {
  it('ログインしていればメールの名前で出す（前後の空白は外す）', () => {
    expect(defaultLoginLabel('claude', { signedIn: true, email: ' taro@example.com ' })).toBe('taro@example.com')
    expect(defaultLoginLabel('codex', { signedIn: true, email: 'hanako@example.com' })).toBe('hanako@example.com')
  })

  it('メールが分からない・未ログイン・まだ読んでいないときは「いつもの … のログイン」。「システムの既定」とは出さない', () => {
    setLocale('ja')
    try {
      for (const identity of [{ signedIn: true, email: null }, { signedIn: true, email: '  ' }, { signedIn: false, email: 'old@example.com' }, null, undefined]) {
        const label = defaultLoginLabel('claude', identity)
        expect(label).toBe('いつもの Claude Code のログイン')
        expect(label).not.toContain('システムの既定')
      }
      expect(defaultLoginLabel('codex', null)).toBe('いつもの Codex のログイン')
    } finally {
      setLocale('en')
    }
    expect(defaultLoginLabel('codex', null)).toBe('Your usual Codex login')
  })
})

describe('前の版で「システムの既定」を選んでいた保存値', () => {
  const account = { id: '11111111-2222-4333-8444-555555555555', label: '', email: 'b@example.com', workspaceLabel: null, createdAt: 1, updatedAt: 1, lastAuthenticatedAt: 1 }

  it('null はそのまま残り、いつものログインの行（同じアカウント）を指す。追加したアカウントへ勝手に切り替えない', () => {
    const next = sanitizeAgentAccounts({ claude: { accounts: [account], activeAccountId: null }, codex: { accounts: [], activeAccountId: null } })
    expect(next.claude.activeAccountId).toBeNull()
    expect(next.codex.activeAccountId).toBeNull()
  })

  it('消えたアカウントを指していれば、いつものログインに戻す。残っているアカウントの選択はそのまま', () => {
    expect(sanitizeAgentAccounts({ claude: { accounts: [account], activeAccountId: '99999999-2222-4333-8444-555555555555' } }).claude.activeAccountId).toBeNull()
    expect(sanitizeAgentAccounts({ claude: { accounts: [account], activeAccountId: account.id } }).claude.activeAccountId).toBe(account.id)
  })
})
