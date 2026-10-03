import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { QUIET } from './facade-fixtures.js'
import { createKernelFrom } from './facade.js'
import { KernelTest } from './kernel-test.js'
import { PluginHost } from './plugins/plugin-host.js'
import { tempDir } from './testing/temp-repo.js'

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

// The plugins cannot be loaded, however the kernel was composed
const failingLoad = Layer.effect(
  PluginHost,
  PluginHost.useSync((host) =>
    PluginHost.of({ ...host, load: () => Effect.die(new Error('the plugins cannot be loaded')) }),
  ),
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
