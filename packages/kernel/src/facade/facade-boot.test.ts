import { Effect, Layer } from 'effect'
import { describe, expect, it, onTestFinished } from 'vitest'
import { QUIET } from './facade-fixtures.js'
import { createKernelFrom } from '../facade.js'
import { KernelTest } from '../kernel-test.js'
import { PluginHost } from '../plugins/plugin-host.js'
import { leftBehind, leftIdOf, seedProject } from '../sessions/session-recover-fixtures.js'
import { tempDir } from '../testing/temp-repo.js'

// Notes in the journal that its layer was released, which happens when the runtime is disposed
const releasing = (journal: string[]): Layer.Layer<never> =>
  Layer.effectDiscard(
    Effect.addFinalizer(() =>
      Effect.sync(() => {
        journal.push('released')
      }),
    ),
  )

// Everything the kernel stands on is up when the layer that dies is built
const dying = Layer.effectDiscard(Effect.die(new Error('this layer cannot be built')))

// A layer whose release fails, so disposing the runtime rejects as well
const failingRelease = Layer.effectDiscard(
  Effect.addFinalizer(() => Effect.die(new Error('this layer cannot be released'))),
)

// The plugins cannot be loaded, however the kernel was composed
const failingLoad = Layer.effect(
  PluginHost,
  PluginHost.useSync((host) =>
    PluginHost.of({ ...host, load: () => Effect.die(new Error('the plugins cannot be loaded')) }),
  ),
)

const EARLIER = 'earlier'

// What a previous process left in the store: a session at work, its turn running
const leftByAnother = Layer.effectDiscard(
  Effect.andThen(seedProject(EARLIER), leftBehind(EARLIER, 'running')).pipe(Effect.orDie),
)

describe('a kernel that cannot start', () => {
  it('releases its layers when one of them cannot be built, and rejects with that failure', async () => {
    expect.hasAssertions()
    const journal: string[] = []
    const home = tempDir('bb-home-')
    const layer = dying.pipe(
      Layer.provideMerge(releasing(journal)),
      Layer.provideMerge(KernelTest({ home })),
    )
    const starting = createKernelFrom(layer, { home, env: {}, logging: QUIET })
    await expect(starting).rejects.toThrow('this layer cannot be built')
    expect(journal).toStrictEqual(['released'])
  })

  it('releases its layers when the plugins cannot be loaded, and rejects with that failure', async () => {
    expect.hasAssertions()
    const journal: string[] = []
    const home = tempDir('bb-home-')
    const layer = failingLoad.pipe(
      Layer.provideMerge(releasing(journal)),
      Layer.provideMerge(KernelTest({ home })),
    )
    const starting = createKernelFrom(layer, { home, env: {}, logging: QUIET })
    await expect(starting).rejects.toThrow('the plugins cannot be loaded')
    expect(journal).toStrictEqual(['released'])
  })

  it('rejects with the failure of the start even when disposing the runtime fails too', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const layer = failingLoad.pipe(
      Layer.provideMerge(failingRelease),
      Layer.provideMerge(KernelTest({ home })),
    )
    const starting = createKernelFrom(layer, { home, env: {}, logging: QUIET })
    await expect(starting).rejects.toThrow('the plugins cannot be loaded')
  })

  it('keeps the layers of a kernel that starts until it is closed', async () => {
    expect.hasAssertions()
    const journal: string[] = []
    const home = tempDir('bb-home-')
    const layer = releasing(journal).pipe(Layer.provideMerge(KernelTest({ home })))
    const kernel = await createKernelFrom(layer, { home, env: {}, logging: QUIET })
    expect(journal).toStrictEqual([])
    await kernel.close()
    expect(journal).toStrictEqual(['released'])
  })
})

describe('a kernel that starts after another process', () => {
  it('stops what that process left at work before it serves, and finds nothing more', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const layer = leftByAnother.pipe(Layer.provideMerge(KernelTest({ home })))
    const kernel = await createKernelFrom(layer, { home, env: {}, logging: QUIET })
    onTestFinished(async () => {
      await kernel.close()
    })
    const sessionId = leftIdOf(EARLIER, 'running')
    const events = await kernel.events.read({ sessionId }, { from: 0 })
    await expect(kernel.sessions.get(sessionId)).resolves.toMatchObject({ status: 'stopped' })
    expect(events.map((event) => event.type)).toStrictEqual(['turn.interrupted', 'session.stopped'])
    await expect(kernel.sessions.recover()).resolves.toStrictEqual([])
  })
})
