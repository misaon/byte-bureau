import { ok, strictEqual } from 'node:assert/strict'
import { SessionStatus } from '@bytebureau/protocol'
import { assert, commands, constant, modelRun, property, type Command } from 'fast-check'
import { describe, expect, it } from 'vitest'
import { SESSION_EVENTS, transition, type SessionEvent } from './state-machine.js'

const TERMINAL = new Set<SessionStatus>(['completed'])
const KNOWN = new Set<string>(SessionStatus.literals)

interface Tracked {
  status: SessionStatus
}

// One event offered to the machine; the model and the real status must agree on what it does
class Step implements Command<Tracked, Tracked> {
  public readonly event: SessionEvent

  public constructor(event: SessionEvent) {
    this.event = event
  }

  public check(): boolean {
    return SESSION_EVENTS.includes(this.event)
  }

  public run(model: Tracked, real: Tracked): void {
    const next = transition(real.status, this.event)
    if (next === null) {
      strictEqual(real.status, model.status)
      return
    }
    ok(!TERMINAL.has(model.status), `${model.status} must not be left`)
    ok(KNOWN.has(next), `${next} is not a status`)
    model.status = next
    real.status = next
  }

  public toString(): string {
    return this.event
  }
}

const start = (): { model: Tracked; real: Tracked } => ({
  model: { status: 'created' },
  real: { status: 'created' },
})

type Edge = readonly [SessionStatus, SessionEvent, SessionStatus]

const EDGES: readonly Edge[] = [
  ['created', 'provision', 'provisioning'],
  ['provisioning', 'provisioned', 'ready'],
  ['ready', 'prompt', 'running'],
  ['running', 'ask', 'waiting_for_human'],
  ['waiting_for_human', 'answer', 'running'],
  ['running', 'turn_done', 'ready'],
  ['waiting_for_human', 'turn_done', 'ready'],
  ['running', 'rate_limit', 'paused_usage_limit'],
  ['paused_usage_limit', 'limit_reset', 'running'],
  ['running', 'stop', 'stopped'],
  ['ready', 'stop', 'stopped'],
  ['waiting_for_human', 'stop', 'stopped'],
  ['paused_usage_limit', 'stop', 'stopped'],
  ['provisioning', 'stop', 'stopped'],
  ['created', 'stop', 'stopped'],
  ['created', 'crash', 'errored'],
  ['running', 'crash', 'errored'],
  ['waiting_for_human', 'crash', 'errored'],
  ['provisioning', 'crash', 'errored'],
  ['ready', 'complete', 'completed'],
  ['stopped', 'resume', 'ready'],
  ['errored', 'resume', 'ready'],
]

const REFUSED: readonly (readonly [SessionStatus, SessionEvent])[] = [
  ['completed', 'prompt'],
  ['created', 'prompt'],
  ['ready', 'answer'],
  ['running', 'complete'],
  ['errored', 'stop'],
  ['stopped', 'prompt'],
  ['ready', 'crash'],
]

describe(transition, () => {
  it.each(EDGES)('moves a %s session on %s to %s', (from, event, to) => {
    expect(transition(from, event)).toBe(to)
  })

  it.each(REFUSED)('refuses %s on %s', (status, event) => {
    expect(transition(status, event)).toBeNull()
  })

  it('refuses every event once a session is completed', () => {
    expect(SESSION_EVENTS.map((event) => transition('completed', event))).toStrictEqual(
      SESSION_EVENTS.map(() => null),
    )
  })

  it('never leaves a terminal state and only produces known statuses (model-based)', () => {
    const steps = SESSION_EVENTS.map((event) => constant(new Step(event)))
    const sequences = property(commands(steps, { maxCommands: 40 }), (all) => {
      modelRun(start, all)
    })
    expect(() => {
      assert(sequences, { numRuns: 300 })
    }).not.toThrow()
  })
})
