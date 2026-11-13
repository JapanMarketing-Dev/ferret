import { describe, expect, it } from 'vitest'
import { FOCUS_RELOAD_MIN_GAP_MS, reloadDelay, resourcePollMs } from '../../src/renderer/lib/idlePolling'
import { LOGIN_POLL_WINDOW_MS, loginPollRemaining } from '../../src/renderer/hooks/useAgentAccounts'
import { GIT_FOCUS_MIN_GAP_MS } from '../../src/renderer/lib/useGitDecorations'

/** 何もしていない間に、定期の読み直しで git・ps・アカウントの読み直しを走らせ続けない */
describe('何もしていない間の読み直し', () => {
  it('フッターの git：ファイルの変更はまとめて、前回から30秒は空ける。まだ読んでいなければ待ちだけ', () => {
    expect(reloadDelay(10_000, null, 2_000, 30_000)).toBe(2_000)
    expect(reloadDelay(10_000, 9_000, 2_000, 30_000)).toBe(29_000)
    expect(reloadDelay(100_000, 9_000, 2_000, 30_000)).toBe(2_000)
    expect(FOCUS_RELOAD_MIN_GAP_MS).toBe(30_000)
    expect(GIT_FOCUS_MIN_GAP_MS).toBe(30_000)
  })

  it('Resource Manager：開いている間は 1.5 秒、数字だけなら 60 秒、数字も隠れていれば取らない', () => {
    expect(resourcePollMs(true, false)).toBe(1500)
    expect(resourcePollMs(true, true)).toBe(1500)
    expect(resourcePollMs(false, true)).toBe(60_000)
    expect(resourcePollMs(false, false)).toBeNull()
  })

  it('アカウント：ログインを始めてから5分だけ、ログイン待ちの行がある間に読み直す', () => {
    expect(loginPollRemaining(1_000, 0, true)).toBe(LOGIN_POLL_WINDOW_MS - 1_000)
    expect(loginPollRemaining(LOGIN_POLL_WINDOW_MS + 1, 0, true)).toBe(0)
    expect(loginPollRemaining(1_000, 0, false)).toBe(0)
    // 一度もログインを始めていない（起動から残っているログイン待ちの行）なら読み直さない
    expect(loginPollRemaining(Date.now(), 0, true)).toBe(0)
  })
})
