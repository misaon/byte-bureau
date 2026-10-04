import { EventEnvelope } from '@bytebureau/protocol'
import { Effect, Schema } from 'effect'
import type { HttpServer } from 'effect/http'
import { API_PREFIX } from './api.js'
import { authorized, baseUrl } from './testing.js'

export interface SseFrame {
  readonly id: string | undefined
  readonly event: string
  readonly data: string
}

// One SSE frame from its lines; a line without a colon is a field with an empty value
const parseFrame = (block: string): SseFrame => {
  const fields = new Map<string, string>()
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':')
    const key = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /u, '')
    fields.set(
      key,
      fields.has(key) && key === 'data' ? `${fields.get(key) ?? ''}\n${value}` : value,
    )
  }
  return {
    id: fields.get('id'),
    event: fields.get('event') ?? 'message',
    data: fields.get('data') ?? '',
  }
}

const textOf = (response: Response, signal: AbortSignal | undefined): ReadableStream<string> => {
  if (response.body === null) {
    throw new Error('the response has no body')
  }
  const options = signal === undefined ? {} : { signal }
  return response.body.pipeThrough(new TextDecoderStream(), options)
}

// The frames of a text/event-stream response, each as soon as its blank line has come
async function* framesOf(
  response: Response,
  signal: AbortSignal | undefined,
): AsyncGenerator<SseFrame> {
  let pending = ''
  for await (const text of textOf(response, signal)) {
    const blocks = (pending + text).split('\n\n')
    pending = blocks.pop() ?? ''
    yield* blocks.filter((block) => block.trim() !== '').map((block) => parseFrame(block))
  }
}

// Reads frames until the predicate says enough or the stream ends; leaving the loop cancels the response, which closes the connection
// An aborted signal stops the reading the same way, so a test that is interrupted leaves no stream open
async function readSse(
  response: Response,
  until: (frames: readonly SseFrame[]) => boolean,
  signal?: AbortSignal,
): Promise<SseFrame[]> {
  const frames: SseFrame[] = []
  for await (const frame of framesOf(response, signal)) {
    frames.push(frame)
    if (until(frames)) {
      break
    }
  }
  return frames
}

// The event stream as a client opens it: the answer is there once the server has sent its headers
// A test that is interrupted while it waits for them aborts the request
export const opened = (
  query = '',
  init: RequestInit = {},
): Effect.Effect<Response, never, HttpServer.HttpServer> =>
  Effect.gen(function* opens() {
    const base = yield* baseUrl
    const url = `${base}${API_PREFIX}/events${query === '' ? '' : `?${query}`}`
    return yield* Effect.promise(async (signal) => {
      const response = await fetch(url, { ...authorized(init), signal })
      return response
    })
  })

// What an open stream sends until the predicate says enough
export const framesUntil = (
  response: Response,
  until: (frames: readonly SseFrame[]) => boolean,
): Effect.Effect<SseFrame[]> =>
  Effect.promise(async (signal) => {
    const frames = await readSse(response, until, signal)
    return frames
  })

// The frames that carry an id are the durable events; the rest are ephemeral
export const durableOf = (frames: readonly SseFrame[]): SseFrame[] =>
  frames.filter((frame) => frame.id !== undefined)

export const seqNumbersOf = (frames: readonly SseFrame[]): number[] =>
  durableOf(frames).map((frame) => Number(frame.id))

// What a frame carries as its data, read through the protocol's schema
export const envelopeOf = (frame: SseFrame): EventEnvelope =>
  Schema.decodeUnknownSync(Schema.fromJsonString(EventEnvelope))(frame.data)
