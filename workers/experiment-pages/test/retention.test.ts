import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { Env } from '../src/env'
import worker from '../src/index'
import { runRetention } from '../src/retention'
import { countRows } from './helpers'

async function seedInterest(id: string, createdAt: string) {
  await env.DB.prepare(
    "INSERT INTO interests (id, slug, experiment_id, day, name, company, email, message, created_at) VALUES (?, 'p', 'X01', '2026-01-01', '', '', 'a@example.com', '', ?)",
  )
    .bind(id, createdAt)
    .run()
}

async function seedHash(day: string) {
  await env.DB.prepare("INSERT INTO seen_hashes (slug, day, kind, hash) VALUES ('p', ?, 'view', ?)")
    .bind(day, `h-${day}`)
    .run()
}

describe('retention', () => {
  const now = new Date('2026-10-17T18:17:00Z') // JST 2026-10-18 03:17

  it('deletes interests older than 180 days (boundary)', async () => {
    const cutoff = now.getTime() - 180 * 86_400_000
    await seedInterest('old', new Date(cutoff - 1).toISOString())
    await seedInterest('edge', new Date(cutoff).toISOString())
    await seedInterest('new', new Date(cutoff + 1).toISOString())
    const r = await runRetention(env.DB, now)
    expect(r.interests).toBe(1)
    const ids = (await env.DB.prepare('SELECT id FROM interests ORDER BY id').all<{ id: string }>()).results.map(
      (x) => x.id,
    )
    expect(ids).toEqual(['edge', 'new'])
  })
  it('deletes dedupe hashes older than 2 days (JST)', async () => {
    for (const d of ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']) await seedHash(d)
    const r = await runRetention(env.DB, now)
    expect(r.seenHashes).toBe(2)
    const days = (await env.DB.prepare('SELECT day FROM seen_hashes ORDER BY day').all<{ day: string }>()).results.map(
      (x) => x.day,
    )
    expect(days).toEqual(['2026-10-16', '2026-10-17', '2026-10-18'])
  })
  it('deletes expired rate counters only', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO rate_counters VALUES ('a', 'b1', 1, '2026-10-17T18:16:59.000Z')"),
      env.DB.prepare("INSERT INTO rate_counters VALUES ('a', 'b2', 1, '2026-10-17T18:17:01.000Z')"),
    ])
    const r = await runRetention(env.DB, now)
    expect(r.rateCounters).toBe(1)
    expect(await countRows('rate_counters')).toBe(1)
  })
  it('keeps aggregate daily_stats forever (no PII)', async () => {
    await env.DB.prepare("INSERT INTO daily_stats VALUES ('p', '2020-01-01', 5, 3, 1)").run()
    await runRetention(env.DB, now)
    expect(await countRows('daily_stats')).toBe(1)
  })
  it('is idempotent on an empty database', async () => {
    expect(await runRetention(env.DB, now)).toEqual({ interests: 0, seenHashes: 0, rateCounters: 0 })
  })
  it('runs from the cron (scheduled) handler using scheduledTime', async () => {
    await seedInterest('cron-old', '2026-01-01T00:00:00.000Z')
    await seedHash('2026-10-01')
    const controller = createScheduledController({ scheduledTime: now, cron: '17 18 * * *' })
    const ctx = createExecutionContext()
    await (worker as Required<Pick<ExportedHandler<Env>, 'scheduled'>>).scheduled(controller, env as Env, ctx)
    await waitOnExecutionContext(ctx)
    expect(await countRows('interests')).toBe(0)
    expect(await countRows('seen_hashes')).toBe(0)
  })
})
