import type { EventEnvelope } from '@bytebureau/protocol'
import { describe, expect, it } from 'vitest'
import { event } from '../testing/events.js'
import {
  captureConsole,
  COMPLETED,
  contextOf,
  OPTIONS,
  scripted,
  STOPPED,
  TURN_DONE,
} from '../testing/scripted-kernel.js'
import { runSession } from './run-session.js'

// An event of the type whose payload belongs to another type
function malformed(type: string, seq: number): EventEnvelope {
  return { ...event('session.ready', { status: 'ready' }, seq), type }
}

function skipped(type: string, seq: number): string {
  return `Skipped the ${type} event (seq ${seq}): its payload does not fit its type`
}

describe('runSession with an event whose payload does not fit its type', () => {
  it('skips the line, with one warning that names the event, and goes on', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const said = event('message.assistant.completed', { text: 'Fixed it', content: [] }, 3)
    const { kernel } = scripted([malformed('tool.started', 2), said, TURN_DONE, COMPLETED])
    await expect(runSession(kernel, OPTIONS, contextOf())).resolves.toBe(0)
    expect(printed.out()).toStrictEqual([
      'Fixed it',
      'Done — turns: 1, input tokens: 10, output tokens: 5',
    ])
    expect(printed.err()).toStrictEqual([skipped('tool.started', 2)])
  })

  it('counts the turns it can read, and warns about the one it cannot', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { kernel, calls } = scripted([malformed('turn.completed', 2), COMPLETED])
    await expect(runSession(kernel, OPTIONS, contextOf())).resolves.toBe(0)
    expect(calls).toContain('complete s1')
    expect(printed.out()).toStrictEqual(['Done — turns: 0, input tokens: 0, output tokens: 0'])
    expect(printed.err()).toStrictEqual([skipped('turn.completed', 2)])
  })

  it('leaves an ask it cannot read to the kernel policy, and says that it skipped it', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { kernel, answered } = scripted([malformed('ask.requested', 2), STOPPED])
    await expect(runSession(kernel, { ...OPTIONS, yes: true }, contextOf())).resolves.toBe(3)
    expect(answered).toStrictEqual([])
    expect(printed.err()).toStrictEqual([skipped('ask.requested', 2)])
  })

  it('still ends with the code of an errored session whose reason it cannot read', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { kernel } = scripted([malformed('session.errored', 2)])
    await expect(runSession(kernel, OPTIONS, contextOf())).resolves.toBe(4)
    expect(printed.err()).toStrictEqual([
      skipped('session.errored', 2),
      'The provider failed: session.errored',
    ])
  })
})

describe('runSession with machine-readable output and an event that does not fit its type', () => {
  it('passes the event on, builds no summary and warns of nothing', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const bad = malformed('turn.completed', 2)
    const { kernel } = scripted([bad, COMPLETED])
    await expect(runSession(kernel, OPTIONS, contextOf(true))).resolves.toBe(0)
    expect(printed.out()).toStrictEqual([JSON.stringify(bad), JSON.stringify(COMPLETED)])
    expect(printed.err()).toStrictEqual([])
  })
})
