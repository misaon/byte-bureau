import type { AgentSession } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect, Fiber, Latch } from 'effect'
import { describe, expect, it as test } from 'vitest'
import { LiveSessions, type Live } from './live-sessions.js'
import type { Session } from './types.js'

const idle = async (): Promise<void> => {
  await Promise.resolve()
}

const agent: AgentSession = {
  externalRef: null,
  prompt: idle,
  interrupt: idle,
  answer: idle,
  events: () => ({
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        await idle()
        return { value: undefined, done: true }
      },
    }),
  }),
  close: idle,
}

const session = (id: string): Session => ({
  id,
  projectId: 'p',
  title: 't',
  employee: {
    id: 'developer',
    name: 'Developer',
    provider: 'fake',
    model: 'm',
    effort: null,
    systemPrompt: '',
    tools: { allow: [], deny: [] },
    permissionMode: 'supervised',
    skills: [],
    appearance: {},
  },
  providerId: 'fake',
  profileId: null,
  workspace: null,
  externalRef: null,
  status: 'ready',
  createdAt: 't',
  startedAt: null,
  endedAt: null,
})

const liveOf = (id: string): Live => ({
  session: session(id),
  workspacePath: '/ws',
  agent,
  interruptible: true,
  controller: new AbortController(),
  tools: new Map(),
  pump: undefined,
  turn: null,
  interrupted: null,
  closed: false,
})

describe(LiveSessions, () => {
  test('finds the provider session that was added and lists them all', () => {
    const sessions = new LiveSessions()
    const first = liveOf('one')
    const second = liveOf('two')
    sessions.add(first)
    sessions.add(second)
    expect(sessions.get('one')).toBe(first)
    expect(sessions.all()).toStrictEqual([first, second])
    expect(sessions.get('three')).toBeUndefined()
  })

  test('removes only the provider session it was given, not a newer one that took its place', () => {
    const sessions = new LiveSessions()
    const old = liveOf('one')
    const newer = liveOf('one')
    sessions.add(old)
    sessions.add(newer)
    sessions.remove(old)
    expect(sessions.get('one')).toBe(newer)
    sessions.remove(newer)
    expect(sessions.get('one')).toBeUndefined()
  })

  test('has the environment given at creation, and none for a session it does not know', () => {
    const sessions = new LiveSessions()
    const environment = { extra: { BYTEBUREAU_X: '1' }, passEnv: ['GH_TOKEN'] }
    sessions.setEnvironment('one', environment)
    expect(sessions.environmentOf('one')).toStrictEqual(environment)
    expect(sessions.environmentOf('nobody')).toStrictEqual({ extra: {}, passEnv: [] })
  })

  test('forgets the environment of a session that ended', () => {
    const sessions = new LiveSessions()
    sessions.setEnvironment('one', { extra: { BYTEBUREAU_X: '1' }, passEnv: [] })
    sessions.forget('one')
    expect(sessions.environmentOf('one')).toStrictEqual({ extra: {}, passEnv: [] })
    expect(sessions.sizes()).toStrictEqual({ locks: 0, environments: 0 })
  })
})

// A change that notes when it begins, waits for the latch and notes when it ends
const note = (journal: string[], what: string): Effect.Effect<void> =>
  Effect.sync(() => {
    journal.push(what)
  })

const held = (journal: string[], name: string, latch: Latch.Latch): Effect.Effect<void> =>
  Effect.andThen(
    note(journal, `${name} begins`),
    Effect.andThen(latch.await, note(journal, `${name} ends`)),
  )

it.effect('runs the changes of one session one at a time', () =>
  Effect.gen(function* serialisesChanges() {
    const sessions = new LiveSessions()
    const journal: string[] = []
    const release = yield* Latch.make()
    const first = sessions.exclusive('one', held(journal, 'first', release))
    const second = sessions.exclusive('one', note(journal, 'second runs'))
    yield* Effect.all([first, second, release.open], { concurrency: 'unbounded' })
    assert.deepStrictEqual(journal, ['first begins', 'first ends', 'second runs'])
  }),
)

// The number of locks while a change holds one and another waits for it, then once both are done
const lockCounts = (sessions: LiveSessions): Effect.Effect<readonly number[]> =>
  Effect.gen(function* countsLocks() {
    const release = yield* Latch.make()
    const sizes: number[] = []
    const measure = Effect.sync(() => {
      sizes.push(sessions.sizes().locks)
    })
    const holding = sessions.exclusive('one', Effect.andThen(measure, release.await))
    const waiting = sessions.exclusive('one', measure)
    const both = yield* Effect.forkChild(
      Effect.all([holding, waiting], { concurrency: 'unbounded' }),
      {
        startImmediately: true,
      },
    )
    yield* Effect.andThen(measure, release.open)
    yield* Fiber.join(both)
    yield* measure
    return sizes
  })

it.effect('keeps a lock only while somebody holds it or waits for it', () =>
  Effect.gen(function* releasesIdleLocks() {
    assert.deepStrictEqual(yield* lockCounts(new LiveSessions()), [1, 1, 1, 0])
  }),
)

it.effect('lets the changes of different sessions run side by side', () =>
  Effect.gen(function* overlapsSessions() {
    const sessions = new LiveSessions()
    const journal: string[] = []
    const release = yield* Latch.make()
    const blocked = sessions.exclusive('one', held(journal, 'one', release))
    const other = sessions.exclusive('two', note(journal, 'two runs'))
    const opening = Effect.andThen(Effect.yieldNow, release.open)
    yield* Effect.all([blocked, other, opening], { concurrency: 'unbounded' })
    assert.deepStrictEqual(journal, ['one begins', 'two runs', 'one ends'])
  }),
)
