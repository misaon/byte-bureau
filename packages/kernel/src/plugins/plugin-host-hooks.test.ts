import type {
  AgentSpawnInput,
  AskOpenInput,
  KernelEvent,
  PromptSendInput,
  SessionCreateInput,
} from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { hostOver, loadedHost, noting, probe } from './plugin-fixtures.js'

const calls: string[] = []

const wired = probe('wired', {
  hooks: {
    'session.beforeCreate': noting(calls, 'session.beforeCreate'),
    'agent.beforeSpawn': noting(calls, 'agent.beforeSpawn'),
    'ask.beforeOpen': noting(calls, 'ask.beforeOpen'),
    'prompt.beforeSend': noting(calls, 'prompt.beforeSend'),
    'event.beforePublish': noting(calls, 'event.beforePublish'),
  },
})

const creation: SessionCreateInput = {
  projectId: 'p',
  employeeId: 'e',
  providerId: 'x',
  title: 't',
}
const spawning: AgentSpawnInput = {
  sessionId: 's',
  providerId: 'x',
  command: 'agent',
  args: [],
  env: {},
}
const asking: AskOpenInput = {
  ask: {
    id: 'a',
    sessionId: 's',
    turnId: null,
    kind: 'question',
    title: 'Which one?',
    questions: [],
    policy: { onTimeout: 'wait', timeout: '30m' },
    recommendationSource: 'none',
    status: 'pending',
    createdAt: '2026-10-03T00:00:00.000Z',
    deadlineAt: null,
  },
}
const prompting: PromptSendInput = { sessionId: 's', input: { text: 'hi' } }
const publishing: KernelEvent = { type: 'message.user', sessionId: 's', payload: { text: 'hi' } }

it.layer(hostOver({ extraPlugins: [wired.plugin] }))('PluginHost hooks', (suite) => {
  suite.effect('puts every hook of the contract that a plugin registers on the bus', () =>
    Effect.gen(function* wiresHooks() {
      const { hooks } = yield* loadedHost
      yield* hooks.run('session.beforeCreate', creation, (input) => Effect.succeed(input))
      yield* hooks.run('agent.beforeSpawn', spawning, (input) => Effect.succeed(input))
      yield* hooks.run('ask.beforeOpen', asking, (input) => Effect.succeed(input))
      yield* hooks.run('prompt.beforeSend', prompting, (input) => Effect.succeed(input))
      yield* hooks.run('event.beforePublish', publishing, () => Effect.void)
      assert.deepStrictEqual(calls, [
        'session.beforeCreate',
        'agent.beforeSpawn',
        'ask.beforeOpen',
        'prompt.beforeSend',
        'event.beforePublish',
      ])
    }),
  )
})
