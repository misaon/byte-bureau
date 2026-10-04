import { createServer } from 'node:http'
import { WorkspaceManager } from '@bytebureau/kernel'
import { NodeHttpServer } from '@effect/platform-node'
import { assert, describe, expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { DefectReporter, PortInUseError, portInUse } from './daemon-errors.js'
import { serveApi } from './layer.js'
import { BootedKernel } from './testing-kernel.js'
import { get, post, TEST_TOKEN, testOptions } from './testing.js'
import { called, connected } from './testing-ws.js'

interface Logged {
  readonly message: string
  readonly error: string
  readonly cause: string
}

// What the reporter of the suite logged; each test takes what its own calls added
const logged: Logged[] = []

const DEFECT = { message: 'a handler failed with a defect', error: 'the prune broke' }

// Bun gives EADDRINUSE for a taken port and for an address this machine does not have alike
const EITHER = "the port is taken or the address is not this machine's"

const LOOPBACK = { host: '127.0.0.1', port: 4747 }

const messagesOf = (entries: readonly Logged[]): readonly object[] =>
  entries.map(({ message, error }) => ({ message, error }))

// The kernel of the tests with a prune that dies, as a bug behind a handler would
const DyingPrune = Layer.effect(
  WorkspaceManager,
  WorkspaceManager.use((workspaces) =>
    Effect.succeed({ ...workspaces, prune: () => Effect.die(new Error('the prune broke')) }),
  ),
)

const ReportingLayer = serveApi(testOptions()).pipe(
  Layer.provide(
    DefectReporter((message, properties) => {
      logged.push({
        message,
        error: String(properties['error']),
        cause: String(properties['cause']),
      })
    }),
  ),
  Layer.provide(DyingPrune),
  Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { port: 0, host: '127.0.0.1' })),
  Layer.provideMerge(BootedKernel),
)

describe(portInUse, () => {
  it('names the address of a start that Bun refused, and lets any other failure through', () => {
    const taken = Object.assign(new Error('Failed to start server. Is port 4747 in use?'), {
      code: 'EADDRINUSE',
    })
    const refused = portInUse(taken, { host: '127.0.0.1', port: 4747 })
    expect(refused).toBeInstanceOf(PortInUseError)
    expect(refused).toMatchObject({
      message: `cannot listen on 127.0.0.1:4747: ${EITHER}`,
      cause: taken,
    })
    expect(portInUse(taken, { host: '::1', port: 4747 })).toMatchObject({
      message: `cannot listen on [::1]:4747: ${EITHER}`,
    })
    expect(portInUse(new Error('the store is locked'), LOOPBACK)).toBeUndefined()
    expect(portInUse('EADDRINUSE', LOOPBACK)).toBeUndefined()
  })

  it('reads the code alone too, which Bun also gives for an address this machine does not have', () => {
    const coded = Object.assign(new Error('bind'), { code: 'EADDRINUSE' })
    expect(portInUse(coded, { host: '192.0.2.1', port: 1 })).toMatchObject({
      message: `cannot listen on 192.0.2.1:1: ${EITHER}`,
    })
  })
})

it.layer(ReportingLayer)('the defect reporter of the daemon', (suite) => {
  suite.effect('logs nothing for a refusal the API answers on purpose', () =>
    Effect.gen(function* refuses() {
      const missing = yield* get('/sessions/0192f0a0-0000-7000-8000-000000000009')
      assert.strictEqual(missing.status, 404)
      assert.deepStrictEqual(logged.splice(0), [])
    }),
  )

  suite.effect('logs a defect behind a REST handler, which answers an empty 500', () =>
    Effect.gen(function* failsOverRest() {
      const pruned = yield* post('/workspaces/prune', {})
      assert.strictEqual(pruned.status, 500)
      const entries = logged.splice(0)
      assert.deepStrictEqual(messagesOf(entries), [DEFECT])
      assert.match(entries.map(({ cause }) => cause).join('\n'), /Error: the prune broke/u)
    }),
  )

  suite.effect('logs a defect behind an RPC procedure, which ends with a Die', () =>
    Effect.gen(function* failsOverRpc() {
      const client = yield* connected()
      const prune = { id: 'prune', tag: 'workspaces.prune', payload: {}, token: TEST_TOKEN }
      assert.containSubset(yield* called(client, prune), {
        _tag: 'Exit',
        exit: { _tag: 'Failure', cause: [{ _tag: 'Die' }] },
      })
      assert.deepStrictEqual(messagesOf(logged.splice(0)), [DEFECT])
    }),
  )
})
