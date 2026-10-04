import type { Plugin } from '@bytebureau/plugin-api'
import type { EventEnvelope } from '@bytebureau/protocol'
import { describe, expect, it } from 'vitest'
import { eventsUntil, openKernel } from './facade-fixtures.js'
import { manifestOf, providerOf } from '../plugins/plugin-fixtures.js'
import { createTempRepo } from '../testing/temp-repo.js'

const failing: Plugin = {
  manifest: manifestOf('failing'),
  setup: async () => {
    await Promise.resolve()
    throw new Error('this plugin cannot start')
  },
}

const offering: Plugin = {
  manifest: manifestOf('offering'),
  setup: () => ({ agentProviders: [providerOf('offered')] }),
}

describe('closing the kernel', () => {
  it('ends the iteration that waits for the next event, as an iteration that has run out', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    const project = await kernel.projects.register(createTempRepo())
    const events = kernel.events.subscribe({ projectId: project.id, since: 0 })
    const iterator = events[Symbol.asyncIterator]()
    const replayed = await iterator.next()
    const waiting = iterator.next()
    await kernel.close()
    expect(replayed).toMatchObject({ done: false, value: { type: 'project.registered' } })
    await expect(waiting).resolves.toStrictEqual({ done: true, value: undefined })
  })

  it('rejects the calls made after it, and closing again does no harm', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    await kernel.close()
    await kernel.close()
    await expect(kernel.projects.list()).rejects.toBeInstanceOf(Error)
    await expect(kernel.sessions.list()).rejects.toBeInstanceOf(Error)
  })
})

describe('leaving an iteration of events', () => {
  it('leaves the kernel serving: the next iteration replays what the first one saw', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    const one = await kernel.projects.register(createTempRepo())
    const two = await kernel.projects.register(createTempRepo())
    const atTwo = (event: EventEnvelope): boolean => event.projectId === two.id
    const filter = { types: ['project.registered'], since: 0 }
    const seen = await eventsUntil(kernel.events.subscribe(filter), atTwo)
    const again = await eventsUntil(kernel.events.subscribe(filter), atTwo)
    expect(seen.map((event) => event.projectId)).toStrictEqual([one.id, two.id])
    expect(again).toStrictEqual(seen)
  })
})

describe('starting the kernel', () => {
  it('starts without the plugin that cannot load and offers the agents of the others', async () => {
    expect.hasAssertions()
    const kernel = await openKernel({ extraPlugins: [failing, offering] })
    const ids = kernel.providers.list().map((provider) => provider.id)
    expect(ids).toStrictEqual(['fake', 'offered'])
  })

  it('lists the plugin that cannot load among its plugins and reports itself degraded', async () => {
    expect.hasAssertions()
    const kernel = await openKernel({ extraPlugins: [failing] })
    const states = kernel.plugins.list().map((plugin) => [plugin.name, plugin.state])
    expect(states).toStrictEqual([
      ['workspace-local', 'loaded'],
      ['agent-fake', 'loaded'],
      ['failing', 'failed'],
    ])
    await expect(kernel.health.check()).resolves.toMatchObject({ status: 'degraded' })
  })
})
