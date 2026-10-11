import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { asRecord, isRecord } from '../../src/shared/guards'

describe('外から読んだ値の形', () => {
  it('配列でない object だけを通す', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
    expect(isRecord(Object.create(null))).toBe(true)
    for (const v of [null, undefined, [], [1], 'x', 0, 1, true, () => 1]) expect(isRecord(v), String(v)).toBe(false)
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
    expect(asRecord([])).toBeNull()
    expect(asRecord(null)).toBeNull()
    expect(asRecord(0)).toBeNull()
  })

  it('同じ関数をファイルごとに書き直さない', () => {
    for (const file of ['src/main/accounts/identity.ts', 'src/main/agentWorkspaceTrust.ts', 'src/main/decision/requestBound.ts', 'src/main/decision/openaiDecisions.ts', 'src/main/github/gitlabParse.ts', 'src/main/agentResources/read.ts', 'src/shared/terminalRestore.ts']) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/(function|const) (isRecord|asRecord|isPlainObject)\b/)
    }
  })
})
