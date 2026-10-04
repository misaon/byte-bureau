import { assert, describe, it } from '@effect/vitest'
import { Cause, Effect, ErrorReporter } from 'effect'
import { HttpServerError, HttpServerRequest } from 'effect/http'
import { DefectReporter } from './daemon-errors.js'

const projects = new Request('http://127.0.0.1:4747/api/v1/projects', { method: 'POST' })

// What Bun's body limit leaves behind for a body without a length that outgrows it
const unreadableBody = new HttpServerError.HttpServerError({
  reason: new HttpServerError.RequestParseError({
    request: HttpServerRequest.fromWeb(projects),
    cause: new Error('Request body exceeded maxRequestBodySize'),
  }),
})

// The messages the reporter logs for the cause
const reportedFor = (cause: Cause.Cause<unknown>): Effect.Effect<readonly string[]> =>
  Effect.gen(function* reports() {
    const messages: string[] = []
    const reporter = DefectReporter((message) => {
      messages.push(message)
    })
    yield* ErrorReporter.report(cause).pipe(Effect.provide(reporter))
    return messages
  })

describe(DefectReporter, () => {
  it.effect(
    'logs nothing for a body that could not be read, which is the fault of the client',
    () =>
      Effect.gen(function* clientFault() {
        const broke = Cause.die(new Error('the prune broke'))
        assert.deepStrictEqual(yield* reportedFor(Cause.die(unreadableBody)), [])
        assert.deepStrictEqual(yield* reportedFor(broke), ['a handler failed with a defect'])
      }),
  )
})
