import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { messagesOf, turnsOf } from './session-db-fixtures.js'
import { payloadsOf, sessionOf, startSession } from './session-fixtures.js'
import { workspaceOf } from './session-helper-fixtures.js'
import { SessionManager } from './session-manager.js'
import { prompted } from './session-prompted-fixtures.js'
import { FINISH, push } from './session-push-fixtures.js'
import { driven } from './session-script-fixtures.js'

const PROMPT = 'Create src/hello.ts exporting hello()\r\nwith čeština and an emoji 🚀'
const SECRETIVE = { BYTEBUREAU_COLOUR: 'green', SECRET_TOKEN: 'hunter2' }

// What a caller of create may not decide: the variables the allowlist takes from the daemon, and the id of the session
const FORGED = {
  PATH: '/evil',
  HOME: '/evil',
  TMPDIR: '/evil',
  LANG: 'evil',
  LC_ALL: 'evil',
  TERM: 'evil',
  SSH_AUTH_SOCK: '/evil',
  TRACEPARENT: 'evil',
  BYTEBUREAU_SESSION_ID: 'forged',
  BYTEBUREAU_FAKE_SCRIPT: 'slow',
}

const plain = driven()

it.layer(plain.layer)('SessionManager starts the provider session', (suite) => {
  suite.effect('hands over the workspace, the employee and the profile', () =>
    Effect.gen(function* handsOver() {
      const session = yield* startSession({ providerId: 'scripted' })
      const { agent } = yield* prompted(plain, session)
      const { request } = agent
      assert.deepStrictEqual(request.workspace, { path: workspaceOf(session) })
      assert.strictEqual(request.employee.id, 'developer')
      assert.deepStrictEqual(request.profile, {
        id: 'default',
        providerId: 'scripted',
        kind: 'login',
      })
      assert.strictEqual(request.resume, undefined)
    }),
  )

  suite.effect('passes only what the allowlist lets through, and the id of the session', () =>
    Effect.gen(function* passesAllowlisted() {
      const session = yield* startSession({ providerId: 'scripted', env: SECRETIVE })
      const { agent } = yield* prompted(plain, session)
      const { env } = agent.request
      assert.deepStrictEqual([env['BYTEBUREAU_COLOUR'], env['SECRET_TOKEN']], ['green', undefined])
      assert.strictEqual(env['BYTEBUREAU_SESSION_ID'], session.id)
      assert.ok('PATH' in env)
    }),
  )

  suite.effect('starts the provider session once for the turns of a session', () =>
    Effect.gen(function* startsOnce() {
      const session = yield* startSession({ providerId: 'scripted' })
      const first = yield* prompted(plain, session)
      yield* push(session.id, first.agent, FINISH)
      const second = yield* prompted(plain, session, { text: 'again' })
      assert.strictEqual(second.agent, first.agent)
      assert.deepStrictEqual(
        first.agent.prompts.map((prompt) => prompt.text),
        ['go', 'again'],
      )
      assert.deepStrictEqual(
        (yield* turnsOf(session.id)).map((turn) => turn.idx),
        [0, 1],
      )
    }),
  )
})

it.layer(plain.layer)('SessionManager environment the caller adds', (suite) => {
  suite.effect('keeps the variables of the daemon whatever the caller asks for', () =>
    Effect.gen(function* keepsDaemonVariables() {
      const session = yield* startSession({ providerId: 'scripted', env: FORGED })
      const { agent } = yield* prompted(plain, session)
      const names = Object.keys(FORGED).filter((name) => !name.startsWith('BYTEBUREAU_'))
      const given = names.map((name) => agent.request.env[name])
      assert.deepStrictEqual(
        given,
        names.map((name) => process.env[name]),
      )
    }),
  )

  suite.effect('adds the names of ByteBureau, and the id of the session is the real one', () =>
    Effect.gen(function* addsByteBureauNames() {
      const session = yield* startSession({ providerId: 'scripted', env: FORGED })
      const { agent } = yield* prompted(plain, session)
      const { env } = agent.request
      assert.deepStrictEqual(
        [env['BYTEBUREAU_FAKE_SCRIPT'], env['BYTEBUREAU_SESSION_ID']],
        ['slow', session.id],
      )
    }),
  )
})

const rewriting = driven(
  {},
  {
    'prompt.beforeSend': async (input, proceed) => {
      const sent = await proceed({ ...input, input: { text: 'rewritten by a plugin' } })
      return sent
    },
  },
)

it.layer(rewriting.layer)('SessionManager prompt.beforeSend', (suite) => {
  suite.effect('lets a plugin change what the agent receives and keeps what the caller said', () =>
    Effect.gen(function* rewritesPrompt() {
      const session = yield* startSession({ providerId: 'scripted' })
      const { turn, agent } = yield* prompted(rewriting, session, { text: 'what I said' })
      assert.deepStrictEqual(agent.prompts, [{ text: 'rewritten by a plugin' }])
      assert.deepStrictEqual(turn.prompt, { text: 'what I said' })
      assert.deepStrictEqual(yield* payloadsOf(session.id, 'message.user'), [
        { text: 'what I said' },
      ])
    }),
  )
})

const REFERENCE = { providerId: 'scripted', ref: 'external-1' }
const withReference = driven({ externalRef: REFERENCE })

it.layer(withReference.layer)('SessionManager external reference', (suite) => {
  suite.effect('keeps the reference of the provider session', () =>
    Effect.gen(function* keepsReference() {
      const session = yield* startSession({ providerId: 'scripted' })
      yield* prompted(withReference, session)
      assert.deepStrictEqual((yield* sessionOf(session.id)).externalRef, REFERENCE)
    }),
  )

  suite.effect('hands the reference back to the provider session that resumes', () =>
    Effect.gen(function* resumesWithReference() {
      const sessions = yield* SessionManager
      const session = yield* startSession({ providerId: 'scripted' })
      const first = yield* prompted(withReference, session)
      yield* sessions.stop(session.id)
      yield* sessions.resume(session.id)
      const second = yield* prompted(withReference, session, { text: 'again' })
      assert.notStrictEqual(second.agent, first.agent)
      assert.deepStrictEqual(
        [first.agent.request.resume, second.agent.request.resume],
        [undefined, REFERENCE],
      )
      assert.ok(first.agent.closed)
    }),
  )
})

it.layer(plain.layer)('SessionManager prompt text', (suite) => {
  suite.effect('hands a prompt with CRLF, diacritics and an emoji to the provider unchanged', () =>
    Effect.gen(function* handsPromptOver() {
      const session = yield* startSession({ providerId: 'scripted' })
      const { turn, agent } = yield* prompted(plain, session, { text: PROMPT })
      assert.deepStrictEqual(agent.prompts, [{ text: PROMPT }])
      assert.strictEqual(turn.prompt.text, PROMPT)
      assert.deepStrictEqual(yield* payloadsOf(session.id, 'message.user'), [{ text: PROMPT }])
    }),
  )

  suite.effect('records a prompt with CRLF, diacritics and an emoji unchanged', () =>
    Effect.gen(function* recordsPrompt() {
      const session = yield* startSession({ providerId: 'scripted' })
      yield* prompted(plain, session, { text: PROMPT })
      const [turn] = yield* turnsOf(session.id)
      const [message] = yield* messagesOf(session.id)
      const stored: unknown = JSON.parse(turn === undefined ? 'null' : turn.prompt_json)
      const content: unknown = JSON.parse(message === undefined ? 'null' : message.content_json)
      assert.deepStrictEqual(
        [stored, content],
        [{ text: PROMPT }, [{ type: 'text', text: PROMPT }]],
      )
    }),
  )
})
