#!/usr/bin/env bun
import { guarded, planOf, type SmokePlan } from './smoke-agent.js'
import { runSmoke } from './smoke-run.js'

// An ACP agent through the ACP adapter (spec §16, acceptance 3): the preset SMOKE_ACP_PRESET names, opencode by default
export const acpPlan = (env: Readonly<Record<string, string | undefined>>): SmokePlan =>
  planOf(env, {
    script: 'smoke:acp',
    provider: `acp:${env['SMOKE_ACP_PRESET'] ?? 'opencode'}`,
    variables: [
      'SMOKE_ACP_PRESET=codex|gemini|opencode|pi picks the agent, opencode by default.',
      'The agent must be installed and logged in: codex login, gemini, opencode auth login or pi.',
    ],
  })

/* v8 ignore start */
if (import.meta.main) {
  process.exitCode = await guarded(acpPlan(process.env), process.env, runSmoke)
}
/* v8 ignore stop */
