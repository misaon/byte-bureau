import { Health } from '@bytebureau/kernel'
import { Effect } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { BureauApi } from '../api.js'
import { ApiConfig } from '../config.js'

export const HealthHandlers = HttpApiBuilder.group(BureauApi, 'health', (handlers) =>
  handlers.handle('check', () =>
    Effect.gen(function* checksHealth() {
      const { version, startedAt } = yield* ApiConfig
      const report = yield* Health.use((health) => health.check())
      return { status: report.status, version, startedAt, checks: report.checks }
    }),
  ),
)
