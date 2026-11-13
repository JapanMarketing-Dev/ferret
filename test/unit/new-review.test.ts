import { describe, expect, it } from 'vitest'
import { feedbackPressStartsRecording, planNewReview } from '../../src/renderer/lib/newReview'

const projectIds = ['a', 'b']

describe('新しいレビューをどのプロジェクトで始めるか', () => {
  it('開いているプロジェクトの ＋ は、そのまま始める', () => {
    expect(planNewReview({ projectId: 'a', activeProjectId: 'a', projectIds, recording: false })).toEqual({ action: 'start', projectId: 'a' })
  })

  it('ほかのプロジェクトの ＋ は、そのプロジェクトへ切り替えてから始める', () => {
    expect(planNewReview({ projectId: 'b', activeProjectId: 'a', projectIds, recording: false })).toEqual({ action: 'switch-then-start', projectId: 'b' })
  })

  it('⌘⇧R など指定が無ければ、開いているプロジェクトで始める', () => {
    expect(planNewReview({ activeProjectId: 'b', projectIds, recording: false })).toEqual({ action: 'start', projectId: 'b' })
  })

  it('録画中は始めない（＋ で録画を止めない）', () => {
    expect(planNewReview({ projectId: 'b', activeProjectId: 'a', projectIds, recording: true })).toEqual({ action: 'busy' })
    expect(planNewReview({ projectId: 'a', activeProjectId: 'a', projectIds, recording: true })).toEqual({ action: 'busy' })
  })

  it('プロジェクトが無い・登録の無いプロジェクトでは始められない', () => {
    expect(planNewReview({ activeProjectId: null, projectIds: [], recording: false })).toEqual({ action: 'no-project' })
    expect(planNewReview({ projectId: 'gone', activeProjectId: 'a', projectIds, recording: false })).toEqual({ action: 'no-project' })
  })
})
