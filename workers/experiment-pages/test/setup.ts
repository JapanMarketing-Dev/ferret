import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach } from 'vitest'

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM pages'),
    env.DB.prepare('DELETE FROM daily_stats'),
    env.DB.prepare('DELETE FROM seen_hashes'),
    env.DB.prepare('DELETE FROM interests'),
    env.DB.prepare('DELETE FROM rate_counters'),
  ])
})
