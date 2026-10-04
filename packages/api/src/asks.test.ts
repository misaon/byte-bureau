import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ApiTestLayer, get, post } from './testing.js'
import { askedSession, recommendedOption, UNKNOWN_ID } from './testing-sessions.js'

it.layer(ApiTestLayer())('GET /api/v1/asks over the fake provider', (suite) => {
  suite.effect(
    'lists the pending ask of a session, and the asks of every session without a filter',
    () =>
      Effect.gen(function* lists() {
        const first = yield* askedSession
        const second = yield* askedSession
        const own = yield* get(`/asks?session=${first.session.id}`)
        assert.strictEqual(own.status, 200)
        assert.deepStrictEqual(own.body, [first.ask])
        const all = yield* get('/asks')
        assert.containSubset(all.body, [{ id: first.ask.id }, { id: second.ask.id }])
      }),
  )

  suite.effect('answers 404 ask_not_found for an unknown ask, read or answered', () =>
    Effect.gen(function* missing() {
      const read = yield* get(`/asks/${UNKNOWN_ID}`)
      assert.strictEqual(read.status, 404)
      assert.containSubset(read.body, { code: 'ask_not_found' })
      const answered = yield* post(`/asks/${UNKNOWN_ID}/answer`, { selected: ['yes'] })
      assert.strictEqual(answered.status, 404)
      assert.containSubset(answered.body, { code: 'ask_not_found' })
    }),
  )
})

it.layer(ApiTestLayer())('POST /api/v1/asks/:id/answer over the fake provider', (suite) => {
  suite.effect('refuses an option the ask does not offer with 422 and leaves it pending', () =>
    Effect.gen(function* refuses() {
      const { ask } = yield* askedSession
      const refused = yield* post(`/asks/${ask.id}/answer`, { selected: ['no-such-option'] })
      assert.strictEqual(refused.status, 422)
      assert.containSubset(refused.body, {
        code: 'ask_invalid_answer',
        detail: `ask ${ask.id} has no option no-such-option`,
      })
      assert.containSubset((yield* get(`/asks/${ask.id}`)).body, { status: 'pending' })
    }),
  )

  suite.effect(
    'takes an answer once, reads it back answered via api and refuses a second one',
    () =>
      Effect.gen(function* answers() {
        const { session, ask } = yield* askedSession
        const answer = { selected: [(yield* recommendedOption(ask)).id] }
        assert.strictEqual((yield* post(`/asks/${ask.id}/answer`, answer)).status, 204)
        const again = yield* post(`/asks/${ask.id}/answer`, answer)
        assert.strictEqual(again.status, 409)
        assert.containSubset(again.body, { code: 'ask_not_pending' })
        const read = yield* get(`/asks/${ask.id}`)
        assert.containSubset(read.body, { status: 'answered', answeredVia: 'api', answer })
        assert.deepStrictEqual((yield* get(`/asks?session=${session.id}`)).body, [])
      }),
  )
})
