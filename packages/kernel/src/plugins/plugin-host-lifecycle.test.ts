import { definePlugin, type Plugin } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { EventLog } from '../events/event-log.js'
import { hostOver, loadedHost, manifestOf, probe, startHost } from './plugin-fixtures.js'

const setups: string[] = []
const counted: Plugin = {
  manifest: manifestOf('counted'),
  setup: () => {
    setups.push('counted')
    return {}
  },
}

const journal: string[] = []

// Writes and reads its store while it is disposed, and fails when asked to
const tracked = (name: string, failing = false): Plugin =>
  definePlugin({
    manifest: manifestOf(name),
    setup: (context) => ({
      dispose: async () => {
        await context.kv.set('bye', name)
        const stored = await context.kv.get('bye')
        journal.push(`${name} aborted=${context.signal.aborted} stored=${String(stored)}`)
        if (failing) {
          throw new Error('dispose failed')
        }
      },
    }),
  })

const watcher = probe('watcher')

// A registration whose dispose counts on being called as its method
const tally = {
  disposed: 0,
  async dispose(): Promise<void> {
    await Promise.resolve()
    this.disposed += 1
  },
}
const stateful: Plugin = { manifest: manifestOf('stateful'), setup: () => tally }

it.layer(hostOver({ extraPlugins: [counted] }))('PluginHost load', (suite) => {
  suite.effect('loads once: more calls set nothing up again and announce nothing again', () =>
    Effect.gen(function* loadsOnce() {
      const host = yield* loadedHost
      yield* Effect.all([host.load(), host.load()], { concurrency: 'unbounded' })
      yield* host.load()
      const events = yield* (yield* EventLog).read({ types: ['plugin.loaded'] }, { from: 0 })
      assert.deepStrictEqual(setups, ['counted'])
      assert.strictEqual(events.length, host.plugins().length)
    }),
  )
})

it.effect('aborts the signal, then disposes in reverse order, whatever one dispose does', () =>
  Effect.gen(function* disposesInReverse() {
    const extraPlugins = [
      tracked('first'),
      tracked('second', true),
      tracked('third'),
      watcher.plugin,
      stateful,
    ]
    const { host, stop } = yield* startHost({ extraPlugins })
    yield* host.load()
    assert.isFalse(watcher.context().signal.aborted)
    yield* stop
    assert.isTrue(watcher.context().signal.aborted)
    assert.strictEqual(tally.disposed, 1)
    assert.deepStrictEqual(journal, [
      'third aborted=true stored=third',
      'second aborted=true stored=second',
      'first aborted=true stored=first',
    ])
  }),
)
