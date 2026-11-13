import {
  VALUE_LIMITS,
  VALUE_USECASE_DIR,
  applyValueResponse,
  parseValueUseCase,
  sortValueDocs,
  type ValueResponse,
  type ValueUseCaseDoc,
  type ValueUseCaseListing
} from '@shared/valueUseCase'
import { listReviewDocs, readReviewDoc, writeReviewDoc } from './visualReview'

/**
 * 価値ユースケースの文書（@shared/valueUseCase）を、開いているプロジェクトの `.ferret/value-usecases/` から読む・返事を書き足す。
 * 読み方・書き方はビジュアルレビューの計画と同じ（./visualReview の listReviewDocs・readReviewDoc・writeReviewDoc）。
 * 画像はビジュアルレビューと同じ readPlanImage（`.ferret/` の下の画像だけ）で読む
 */

const parseDoc = (raw: unknown, id: string): { ok: true; value: ValueUseCaseDoc } | { ok: false; reason: string } => {
  const parsed = parseValueUseCase(raw, id)
  return parsed.ok ? { ok: true, value: parsed.doc } : parsed
}

/** 文書を新しい順に。読めないものは理由を付けて別に返す */
export async function listValueUseCases(root: string): Promise<ValueUseCaseListing> {
  const { entries, invalid } = await listReviewDocs(root, VALUE_USECASE_DIR, parseDoc, { maxBytes: VALUE_LIMITS.docBytes, maxFiles: VALUE_LIMITS.docs * 2 })
  return { docs: sortValueDocs(entries), invalid }
}

/** 返事を書き足す前の文書（生の JSON と読んだもの）。読めなければ null */
export async function readValueUseCase(root: string, id: string): Promise<{ raw: Record<string, unknown>; doc: ValueUseCaseDoc } | null> {
  const doc = await readReviewDoc(root, VALUE_USECASE_DIR, id, parseDoc, VALUE_LIMITS.docBytes)
  return doc ? { raw: doc.raw, doc: doc.value } : null
}

/** 文書に返事（承認・フィードバック）を書き足す。返事できない状態・読めなければ null。書いたあとの文書を返す */
export async function writeValueUseCaseResponse(root: string, id: string, response: Omit<ValueResponse, 'revision'>): Promise<ValueUseCaseDoc | null> {
  const current = await readValueUseCase(root, id)
  if (!current) return null
  const next = applyValueResponse(current.raw, current.doc, response)
  if (!next) return null
  await writeReviewDoc(root, VALUE_USECASE_DIR, id, next)
  const parsed = parseValueUseCase(next, id)
  return parsed.ok ? parsed.doc : null
}
