import type {
  Interest,
  PageContent,
  PageResponse,
  PageStatus,
  PageSummary,
  PutPageRequest,
  StatsResponse,
} from './contract'

interface PageRow {
  slug: string
  experiment_id: string
  title: string
  content_json: string
  status: PageStatus
  created_at: string
  updated_at: string
  published_at: string | null
}

interface InterestRow {
  id: string
  slug: string
  experiment_id: string
  name: string
  company: string
  email: string
  message: string
  created_at: string
}

function toPage(row: PageRow): PageResponse {
  return {
    slug: row.slug,
    experimentId: row.experiment_id,
    title: row.title,
    content: JSON.parse(row.content_json) as PageContent,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    path: `/p/${row.slug}`,
  }
}

export async function getPage(db: D1Database, slug: string): Promise<PageResponse | null> {
  const row = await db.prepare('SELECT * FROM pages WHERE slug = ?').bind(slug).first<PageRow>()
  return row ? toPage(row) : null
}

/** 公開中のページだけを返す。下書きも未登録も同じ 1 回のクエリで null になる。 */
export async function getPublishedPage(db: D1Database, slug: string): Promise<PageResponse | null> {
  const row = await db
    .prepare("SELECT * FROM pages WHERE slug = ? AND status = 'published'")
    .bind(slug)
    .first<PageRow>()
  return row ? toPage(row) : null
}

export async function listPages(db: D1Database): Promise<PageSummary[]> {
  const { results } = await db
    .prepare(
      'SELECT slug, experiment_id, title, status, updated_at, published_at FROM pages ORDER BY updated_at DESC, slug',
    )
    .all<Omit<PageRow, 'content_json' | 'created_at'>>()
  return results.map((r) => ({
    slug: r.slug,
    experimentId: r.experiment_id,
    title: r.title,
    status: r.status,
    updatedAt: r.updated_at,
    publishedAt: r.published_at,
  }))
}

export type UpsertResult =
  | { kind: 'created' | 'updated'; page: PageResponse }
  | { kind: 'conflict'; existingExperimentId: string }

export async function upsertPage(db: D1Database, slug: string, req: PutPageRequest, now: Date): Promise<UpsertResult> {
  const ts = now.toISOString()
  const existing = await db.prepare('SELECT * FROM pages WHERE slug = ?').bind(slug).first<PageRow>()
  const contentJson = JSON.stringify(req.content)
  if (!existing) {
    const publishedAt = req.status === 'published' ? ts : null
    await db
      .prepare(
        'INSERT INTO pages (slug, experiment_id, title, content_json, status, created_at, updated_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(slug, req.experimentId, req.title, contentJson, req.status, ts, ts, publishedAt)
      .run()
    const page = await getPage(db, slug)
    if (!page) throw new Error('page insert failed')
    return { kind: 'created', page }
  }
  if (existing.experiment_id !== req.experimentId) {
    return { kind: 'conflict', existingExperimentId: existing.experiment_id }
  }
  let publishedAt: string | null = null
  if (req.status === 'published') {
    publishedAt = existing.status === 'published' && existing.published_at ? existing.published_at : ts
  }
  await db
    .prepare(
      'UPDATE pages SET title = ?, content_json = ?, status = ?, updated_at = ?, published_at = ? WHERE slug = ?',
    )
    .bind(req.title, contentJson, req.status, ts, publishedAt, slug)
    .run()
  const page = await getPage(db, slug)
  if (!page) throw new Error('page update failed')
  return { kind: 'updated', page }
}

export async function unpublishPage(db: D1Database, slug: string, now: Date): Promise<PageResponse | null> {
  const res = await db
    .prepare("UPDATE pages SET status = 'draft', published_at = NULL, updated_at = ? WHERE slug = ?")
    .bind(now.toISOString(), slug)
    .run()
  if (res.meta.changes === 0) return null
  return getPage(db, slug)
}

export type EventKind = 'view' | 'cta'

/**
 * 表示・CTA を記録する。同じ日・同じ訪問者ハッシュは 1 回だけ数える（表示の総数は毎回数える）。
 * 重複除外ハッシュは slug・日・種類ごとに cap 行まで。行数の確認と挿入を 1 文で行う（並行しても cap を超えない）。
 * 超えたら新しい行を書かず、重複を除いた数も増やさない。
 */
export async function recordEvent(
  db: D1Database,
  slug: string,
  day: string,
  kind: EventKind,
  hash: string,
  cap: number,
): Promise<{ firstToday: boolean }> {
  const ins = await db
    .prepare(
      `INSERT OR IGNORE INTO seen_hashes (slug, day, kind, hash)
       SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM seen_hashes WHERE slug = ? AND day = ? AND kind = ?) < ?`,
    )
    .bind(slug, day, kind, hash, slug, day, kind, cap)
    .run()
  const firstToday = ins.meta.changes > 0
  const uniqueCol = kind === 'view' ? 'unique_visitors' : 'cta_clicks'
  const views = kind === 'view' ? 1 : 0
  const uniq = firstToday ? 1 : 0
  if (views === 0 && uniq === 0) return { firstToday }
  await db
    .prepare(
      `INSERT INTO daily_stats (slug, day, views, ${uniqueCol}) VALUES (?, ?, ?, ?)
       ON CONFLICT (slug, day) DO UPDATE SET views = views + excluded.views, ${uniqueCol} = ${uniqueCol} + excluded.${uniqueCol}`,
    )
    .bind(slug, day, views, uniq)
    .run()
  return { firstToday }
}

export async function getStats(db: D1Database, page: PageResponse, from: string, to: string): Promise<StatsResponse> {
  const [agg, interests] = await db.batch<Record<string, number | null>>([
    db
      .prepare(
        'SELECT SUM(views) AS views, SUM(unique_visitors) AS uniq, SUM(cta_clicks) AS cta FROM daily_stats WHERE slug = ? AND day >= ? AND day <= ?',
      )
      .bind(page.slug, from, to),
    db
      .prepare('SELECT COUNT(*) AS n FROM interests WHERE slug = ? AND day >= ? AND day <= ?')
      .bind(page.slug, from, to),
  ])
  const a = agg?.results[0] ?? {}
  const i = interests?.results[0] ?? {}
  return {
    slug: page.slug,
    experimentId: page.experimentId,
    from,
    to,
    views: Number(a.views ?? 0),
    uniqueVisitors: Number(a.uniq ?? 0),
    ctaClicks: Number(a.cta ?? 0),
    interests: Number(i.n ?? 0),
  }
}

/**
 * 固定窓のカウンタを、上限未満のときだけ 1 増やす（確認と更新を 1 文で行う。並行しても上限を超えない）。
 * 増やせたら true。既に上限なら何も書かずに false
 */
export async function takeCounter(
  db: D1Database,
  key: string,
  bucket: string,
  expiresAt: string,
  limit: number,
): Promise<boolean> {
  if (limit < 1) return false
  const res = await db
    .prepare(
      `INSERT INTO rate_counters (key, bucket, count, expires_at) VALUES (?, ?, 1, ?)
       ON CONFLICT (key, bucket) DO UPDATE SET count = count + 1 WHERE rate_counters.count < ?`,
    )
    .bind(key, bucket, expiresAt, limit)
    .run()
  return res.meta.changes > 0
}

export interface NewInterest {
  slug: string
  experimentId: string
  day: string
  name: string
  company: string
  email: string
  message: string
}

export async function insertInterest(db: D1Database, input: NewInterest, now: Date): Promise<string> {
  const id = crypto.randomUUID()
  await db
    .prepare(
      'INSERT INTO interests (id, slug, experiment_id, day, name, company, email, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      id,
      input.slug,
      input.experimentId,
      input.day,
      input.name,
      input.company,
      input.email,
      input.message,
      now.toISOString(),
    )
    .run()
  return id
}

export async function listInterests(db: D1Database, slug: string, limit: number): Promise<Interest[]> {
  const { results } = await db
    .prepare('SELECT * FROM interests WHERE slug = ? ORDER BY created_at DESC, id LIMIT ?')
    .bind(slug, limit)
    .all<InterestRow>()
  return results.map((r) => ({
    id: r.id,
    slug: r.slug,
    experimentId: r.experiment_id,
    name: r.name,
    company: r.company,
    email: r.email,
    message: r.message,
    createdAt: r.created_at,
  }))
}

export async function deleteInterest(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare('DELETE FROM interests WHERE id = ?').bind(id).run()
  return res.meta.changes > 0
}
