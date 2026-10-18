import * as Sentry from '@sentry/cloudflare'
import { handleFetch, handleScheduled } from './app'
import type { Env } from './env'
import { sentryOptions } from './sentry'

const handler = {
  fetch: (request, env, ctx) => handleFetch(request, env, ctx),
  scheduled: (controller, env) => handleScheduled(controller, env),
} satisfies ExportedHandler<Env>

export default Sentry.withSentry<Env>((env) => sentryOptions(env), handler)
