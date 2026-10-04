import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { framesUntil } from './testing-sse.js'

interface Served {
  readonly response: Response
  readonly cancelled: () => boolean
}

// A response whose body arrives in the chunks given; with open set it never ends by itself
const served = (chunks: readonly string[], open = false): Served => {
  const encoder = new TextEncoder()
  let wasCancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      if (!open) {
        controller.close()
      }
    },
    cancel(): void {
      wasCancelled = true
    },
  })
  return { response: new Response(body), cancelled: () => wasCancelled }
}

const never = (): boolean => false

it.effect('reads the frames whatever the chunks they arrive in', () =>
  Effect.gen(function* reads() {
    const { response } = served([
      'id: 7\neve',
      'nt: turn.started\nda',
      'ta: {"a":"é"}\n',
      '\nid: 8\n\n',
    ])
    const frames = yield* framesUntil(response, never)
    assert.deepStrictEqual(frames, [
      { id: '7', event: 'turn.started', data: '{"a":"é"}' },
      { id: '8', event: 'message', data: '' },
    ])
  }),
)

it.effect('joins the lines of data and reads a line without a colon as an empty field', () =>
  Effect.gen(function* joins() {
    const { response } = served(['data: one\ndata: two\n\nevent\ndata\n\n'])
    const frames = yield* framesUntil(response, never)
    assert.deepStrictEqual(frames, [
      { id: undefined, event: 'message', data: 'one\ntwo' },
      { id: undefined, event: '', data: '' },
    ])
  }),
)

it.effect('stops at the frame that is enough and cancels the response', () =>
  Effect.gen(function* stops() {
    const { response, cancelled } = served(['id: 1\ndata: a\n\nid: 2\ndata: b\n\n'], true)
    const frames = yield* framesUntil(response, (seen) => seen.length === 1)
    assert.deepStrictEqual(frames, [{ id: '1', event: 'message', data: 'a' }])
    assert.isTrue(cancelled())
  }),
)

it.effect('refuses a response without a body', () =>
  Effect.gen(function* refuses() {
    const attempt = framesUntil(new Response(null), never)
    const failure = yield* Effect.flip(Effect.sandbox(attempt))
    assert.include(String(failure), 'the response has no body')
  }),
)
