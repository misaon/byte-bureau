#!/usr/bin/env bun
import { guarded, planOf, type SmokePlan } from './smoke-agent.js'
import { runSmoke } from './smoke-run.js'

// Claude Code through the Agent SDK (spec §16, acceptance 2), on the person's own claude login unless SMOKE_PROFILE names a profile
export const claudePlan = (env: Readonly<Record<string, string | undefined>>): SmokePlan =>
  planOf(env, {
    script: 'smoke:claude',
    provider: 'claude',
    variables: [
      'Without SMOKE_PROFILE it runs on the login of claude itself: log in with claude /login first.',
    ],
  })

/* v8 ignore start */
if (import.meta.main) {
  process.exitCode = await guarded(claudePlan(process.env), process.env, runSmoke)
}
/* v8 ignore stop */
