import { describe, expect, it, vi } from 'vitest'
import { acpPlan } from './smoke-acp.js'
import {
  guarded,
  profileChoiceOf,
  recordOf,
  reportOf,
  sessionOf,
  smokeAllowed,
  summaryOf,
  usageOf,
  type SmokePlan,
} from './smoke-agent.js'
import { claudePlan } from './smoke-claude.js'

const ALLOWED = { SMOKE_REAL_AGENTS: '1' }

describe(guarded, () => {
  it('says how to run the smoke and ends 0 without SMOKE_REAL_AGENTS=1, running nothing', async () => {
    expect.hasAssertions()
    const log = vi.spyOn(console, 'log').mockReturnValue()
    const run = vi.fn<(plan: SmokePlan) => Promise<number>>()
    const codes = [
      await guarded(claudePlan({}), {}, run),
      await guarded(acpPlan({}), { SMOKE_REAL_AGENTS: 'true' }, run),
    ]
    expect([codes, run.mock.calls]).toStrictEqual([[0, 0], []])
    expect(log.mock.calls).toStrictEqual([[usageOf(claudePlan({}))], [usageOf(acpPlan({}))]])
  })

  it('runs the smoke with SMOKE_REAL_AGENTS=1 and ends with its exit code', async () => {
    expect.hasAssertions()
    const run = vi.fn<(plan: SmokePlan) => Promise<number>>().mockResolvedValue(4)
    const plan = claudePlan(ALLOWED)
    await expect(guarded(plan, ALLOWED, run)).resolves.toBe(4)
    expect(run.mock.calls).toStrictEqual([[plan]])
  })

  it('lets a smoke run for the value 1 alone', () => {
    const values = ['1', '0', 'true', 'yes', '', undefined]
    expect(values.map((value) => smokeAllowed({ SMOKE_REAL_AGENTS: value }))).toStrictEqual([
      true,
      false,
      false,
      false,
      false,
      false,
    ])
  })
})

describe('the smoke plans', () => {
  it('run claude, and the ACP preset SMOKE_ACP_PRESET names, opencode by default', () => {
    const plans = [claudePlan({}), acpPlan({}), acpPlan({ SMOKE_ACP_PRESET: 'codex' })]
    expect(plans.map((plan) => [plan.script, plan.provider])).toStrictEqual([
      ['smoke:claude', 'claude'],
      ['smoke:acp', 'acp:opencode'],
      ['smoke:acp', 'acp:codex'],
    ])
  })

  it('tell how to run them, through the package script or the guard variable', () => {
    const usage = usageOf(acpPlan({}))
    expect(usage).toContain('bun run smoke:acp')
    expect(usage).toContain('SMOKE_REAL_AGENTS=1 bun scripts/smoke-acp.ts')
    expect(usage).toContain('SMOKE_ACP_PRESET=')
    expect(usage).toContain('CI never runs it')
  })
})

describe(profileChoiceOf, () => {
  it('runs on the nameless login without SMOKE_PROFILE', () => {
    expect([
      profileChoiceOf(claudePlan({})),
      profileChoiceOf(claudePlan({ SMOKE_PROFILE: '' })),
    ]).toStrictEqual([{ kind: 'nameless' }, { kind: 'nameless' }])
  })

  it('adds the login profile SMOKE_PROFILE names, an id of the provider', () => {
    expect([
      profileChoiceOf(claudePlan({ SMOKE_PROFILE: 'claude/work' })),
      profileChoiceOf(acpPlan({ SMOKE_ACP_PRESET: 'codex', SMOKE_PROFILE: 'acp:codex/home' })),
    ]).toStrictEqual([
      { kind: 'login', id: 'claude/work', name: 'work' },
      { kind: 'login', id: 'acp:codex/home', name: 'home' },
    ])
  })

  it('refuses a profile of another provider and a bare name', () => {
    const kinds = ['acp:codex/work', 'work', 'claude-x/work'].map(
      (profile) => profileChoiceOf(claudePlan({ SMOKE_PROFILE: profile })).kind,
    )
    expect(kinds).toStrictEqual(['refused', 'refused', 'refused'])
  })
})

describe(recordOf, () => {
  it('reads a JSON object and passes over any other line', () => {
    const lines = ['{"type":"turn.started"}', '[1]', '"text"', 'Done', '']
    expect(lines.map((line) => recordOf(line))).toStrictEqual([
      { type: 'turn.started' },
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })
})

describe(sessionOf, () => {
  it('names the session of an event, and none for a record without one', () => {
    const records = [
      { type: 'session.waiting', sessionId: 'abc' },
      { command: 'serve' },
      { sessionId: 7 },
    ]
    expect(records.map((record) => sessionOf(record))).toStrictEqual(['abc', undefined, undefined])
  })
})

const USAGE = { inputTokens: 12, outputTokens: 3, costUsd: 0.01 }

describe(summaryOf, () => {
  it('takes the usage of the last turn and tells whether rate limits and the context were reported', () => {
    const events = [
      { type: 'turn.completed', payload: { stopReason: 'end_turn', usage: { inputTokens: 1 } } },
      {
        type: 'ratelimit.updated',
        payload: { profileId: 'claude/work', rateLimit: { fiveHourPct: 4 } },
      },
      { type: 'usage.updated', payload: { usage: { ...USAGE, contextPct: 7 } } },
      { type: 'turn.completed', payload: { stopReason: 'end_turn', usage: USAGE } },
    ]
    expect(summaryOf(events)).toStrictEqual({ usage: USAGE, rateLimit: true, contextPct: true })
  })

  it('tells nothing seen of a run that completed no turn', () => {
    const events = [{ type: 'session.created', payload: {} }, { type: 'session.errored' }]
    expect(summaryOf(events)).toStrictEqual({
      usage: undefined,
      rateLimit: false,
      contextPct: false,
    })
  })
})

describe(reportOf, () => {
  it('tells the exit code, the usage and what was seen', () => {
    expect(reportOf('run', 0, { usage: USAGE, rateLimit: false, contextPct: true })).toStrictEqual([
      'run exited 0',
      'usage of the turn: {"inputTokens":12,"outputTokens":3,"costUsd":0.01}',
      'ratelimit.updated seen: no',
      'contextPct seen: yes',
    ])
  })
})
