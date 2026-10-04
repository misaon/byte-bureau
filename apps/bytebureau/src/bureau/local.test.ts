import { createKernelFrom, type Kernel } from '@bytebureau/kernel'
import { KernelTest } from '@bytebureau/kernel/testing'
import { decodeEventPayload, type AskRecord, type EventEnvelope } from '@bytebureau/protocol'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createTempRepo, tempDir } from '../testing/temp-repo.js'
import type { Bureau } from './bureau.js'
import { localBureau } from './local.js'

// A kernel over an in-memory store, closed when the test is over; closing it earlier does no harm
async function testKernel(): Promise<Kernel> {
  const home = tempDir('bb-home-')
  const kernel = await createKernelFrom(KernelTest({ home }), {
    home,
    env: {},
    logging: { level: 'error' },
  })
  onTestFinished(async () => {
    await kernel.close()
  })
  return kernel
}

interface Answered {
  // The asks as they were read back by their ids, before they were answered
  readonly read: readonly (AskRecord | undefined)[]
  // What the events tell of the answer
  readonly answered: unknown
}

// The ask the agent puts is read back by its id and answered with its recommended option
async function answerTheAsk(
  bureau: Bureau,
  events: AsyncIterable<EventEnvelope>,
): Promise<Answered> {
  const read: (AskRecord | undefined)[] = []
  for await (const event of events) {
    if (event.type === 'ask.requested') {
      const { ask } = decodeEventPayload('ask.requested', event.payload)
      read.push(await bureau.asks.get(ask.id))
      await bureau.asks.answer(ask.id, { selected: ['yes'] })
    }
    if (event.type === 'ask.answered') {
      return { read, answered: event.payload }
    }
  }
  return { read, answered: undefined }
}

describe(localBureau, () => {
  it('reads the ask of a session by its id and answers it as the CLI', async () => {
    expect.hasAssertions()
    const bureau = localBureau(await testKernel(), '1.2.3')
    const project = await bureau.projects.register(createTempRepo())
    const input = { projectId: project.id, title: 'local', providerId: 'fake' }
    const session = await bureau.sessions.create(input)
    const events = bureau.events.subscribe({ sessionId: session.id, since: 0 })
    await bureau.sessions.prompt(session.id, { text: 'go' })
    await expect(answerTheAsk(bureau, events)).resolves.toMatchObject({
      read: [{ sessionId: session.id, title: 'Export style', status: 'pending' }],
      answered: { answer: { selected: ['yes'] }, answeredVia: 'cli' },
    })
  })

  it('tells its health with the version of the CLI, and the plugins and providers of the kernel', async () => {
    expect.hasAssertions()
    const bureau = localBureau(await testKernel(), '1.2.3')
    const health = await bureau.health.check()
    const plugins = await bureau.plugins.list()
    const providers = await bureau.plugins.providers()
    expect(health).toMatchObject({ status: 'ok', version: '1.2.3', checks: { store: 'ok' } })
    expect(Number.isNaN(Date.parse(health.startedAt))).toBe(false)
    expect(plugins.map((plugin) => plugin.name)).toContain('agent-fake')
    expect(providers.map((provider) => provider.id)).toContain('fake')
  })

  it('says it is in-process, and closes the kernel', async () => {
    expect.hasAssertions()
    const bureau = localBureau(await testKernel(), '1.2.3')
    expect(bureau.where).toStrictEqual({ kind: 'in-process' })
    await bureau.close()
    await expect(bureau.projects.list()).rejects.toBeInstanceOf(Error)
  })
})
