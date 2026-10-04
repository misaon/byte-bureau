import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PluginHost, type KernelServices } from '@bytebureau/kernel'
import { KernelTest } from '@bytebureau/kernel/testing'
import { Effect, Layer } from 'effect'
import type { SqlClient } from 'effect/sql'

// A home of its own for the kernel of a suite, removed when the layer is released; the kernel's tempDir lives only as long as one test
const tempHome = Effect.acquireRelease(
  Effect.sync(() => {
    const created = mkdtempSync(path.join(tmpdir(), 'bb-api-'))
    return realpathSync(created)
  }),
  (home) =>
    Effect.sync(() => {
      rmSync(home, { recursive: true, force: true })
    }),
)

// The test kernel over the home with its plugins loaded, as the daemon loads them at start
const bootedOver = (home: string): Layer.Layer<KernelServices | SqlClient.SqlClient> =>
  Layer.effectDiscard(PluginHost.use((host) => host.load())).pipe(
    Layer.provideMerge(KernelTest({ home, env: {} })),
  )

export const BootedKernel: Layer.Layer<KernelServices | SqlClient.SqlClient> = Layer.unwrap(
  tempHome.pipe(Effect.map((home) => bootedOver(home))),
)
