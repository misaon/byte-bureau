import { createServer } from 'node:http'
import { WorkspaceManager } from '@bytebureau/kernel'
import { NodeHttpServer } from '@effect/platform-node'
import { assert, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { serveApi } from './layer.js'
import { BootedKernel } from './testing-kernel.js'
import { TEST_TOKEN, testOptions } from './testing.js'
import { called, connected } from './testing-ws.js'

// The kernel of the tests with a prune that dies, as a bug behind a handler would
const DyingPrune = Layer.effect(
  WorkspaceManager,
  WorkspaceManager.use((workspaces) =>
    Effect.succeed({ ...workspaces, prune: () => Effect.die(new Error('the prune broke')) }),
  ),
)

const DyingLayer = serveApi(testOptions()).pipe(
  Layer.provide(DyingPrune),
  Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { port: 0, host: '127.0.0.1' })),
  Layer.provideMerge(BootedKernel),
)

it.layer(DyingLayer)('a defect behind a procedure over the WebSocket of /api/v1/ws', (suite) => {
  suite.effect('ends that request with a Die and goes on serving the socket', () =>
    Effect.gen(function* dies() {
      const client = yield* connected()
      const prune = { id: 'prune', tag: 'workspaces.prune', payload: {}, token: TEST_TOKEN }
      assert.containSubset(yield* called(client, prune), {
        _tag: 'Exit',
        requestId: 'prune',
        exit: { _tag: 'Failure', cause: [{ _tag: 'Die' }] },
      })
      client.send({ _tag: 'Ping' })
      assert.deepStrictEqual(yield* client.next, { _tag: 'Pong' })
    }),
  )
})
