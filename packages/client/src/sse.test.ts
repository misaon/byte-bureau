import type { EventEnvelope } from '@bytebureau/protocol'
import { describe, expect, it } from 'vitest'
import { ApiError } from './errors.js'
import { broken, frame, page, serve, status, stream } from './sse-fixture.js'
import { subscribeEvents, type SubscribeOptions } from './sse.js'

// The seq of every event until the one that says enough, which is the last one taken
const seqNumbersUntil = async (
  events: AsyncIterable<EventEnvelope>,
  last: (event: EventEnvelope) => boolean,
): Promise<number[]> => {
  const seen: number[] = []
  for await (const event of events) {
    seen.push(event.seq)
    if (last(event)) {
      break
    }
  }
  return seen
}

// Reads the subscription to its end and gives what it failed with
const failureOf = async (options: SubscribeOptions): Promise<unknown> => {
  try {
    await seqNumbersUntil(subscribeEvents(options), () => false)
  } catch (error) {
    return error
  }
  return undefined
}

const UNAUTHORIZED = {
  type: 'https://bytebureau.dev/problems/unauthorized',
  title: 'Unauthorized',
  status: 401,
  detail: 'a valid API token is required',
  code: 'unauthorized',
}

describe(subscribeEvents, () => {
  it('yields the events, resumes with the last id after the server closes, and sends the bearer token', async () => {
    expect.hasAssertions()
    const served = await serve([
      stream(frame(1, 'session.created') + frame(0, 'message.assistant.delta') + frame(2, 'a')),
      stream(frame(3, 'turn.completed')),
    ])
    const options = { baseUrl: served.url, token: 'tok', filter: { since: 0 }, backoffMs: 10 }
    const numbers = seqNumbersUntil(subscribeEvents(options), (event) => event.seq === 3)
    await expect(numbers).resolves.toStrictEqual([1, 0, 2, 3])
    expect(served.requests.map((request) => request.lastEventId)).toStrictEqual([undefined, '2'])
    expect(served.requests.map((request) => request.url)).toStrictEqual([
      '/api/v1/events?since=0',
      '/api/v1/events?since=2',
    ])
    expect(served.requests.map((request) => request.authorization)).toStrictEqual([
      'Bearer tok',
      'Bearer tok',
    ])
  })

  it('asks for the session, the project and the types of its filter', async () => {
    expect.hasAssertions()
    const served = await serve([stream(frame(7, 'session.ready'))])
    const filter = { sessionId: 's1', projectId: 'p1', types: ['session.ready', 'turn.started'] }
    const events = subscribeEvents({ baseUrl: served.url, token: 'tok', filter })
    await expect(seqNumbersUntil(events, () => true)).resolves.toStrictEqual([7])
    expect(served.requests.map((request) => request.url)).toStrictEqual([
      '/api/v1/events?session=s1&project=p1&types=session.ready,turn.started',
    ])
  })
})

describe('the events of a subscription', () => {
  it('drops ephemeral events when the filter says ephemeral: false', async () => {
    expect.hasAssertions()
    const served = await serve([stream(frame(1, 'a') + frame(0, 'heartbeat') + frame(2, 'b'))])
    const filter = { since: 0, ephemeral: false }
    const events = subscribeEvents({ baseUrl: served.url, token: 'tok', filter, backoffMs: 10 })
    await expect(seqNumbersUntil(events, (event) => event.seq === 2)).resolves.toStrictEqual([1, 2])
  })

  it('skips a frame that does not carry an envelope', async () => {
    expect.hasAssertions()
    const noise = 'event: a\ndata: {"nope":1}\n\nevent: b\ndata: not json\n\n'
    const served = await serve([stream(frame(1, 'a') + noise + frame(2, 'b'))])
    const events = subscribeEvents({ baseUrl: served.url, token: 'tok', filter: {} })
    await expect(seqNumbersUntil(events, (event) => event.seq === 2)).resolves.toStrictEqual([1, 2])
  })

  it('reconnects after an answer that is not the stream', async () => {
    expect.hasAssertions()
    const served = await serve([status(503), stream(frame(4, 'a'))])
    const events = subscribeEvents({ baseUrl: served.url, token: 'tok', filter: {}, backoffMs: 10 })
    await expect(seqNumbersUntil(events, () => true)).resolves.toStrictEqual([4])
    expect(served.requests).toHaveLength(2)
  })
})

describe('where a subscription resumes', () => {
  it('resumes after the last durable event, which a heartbeat after it does not move', async () => {
    expect.hasAssertions()
    const served = await serve([
      stream(frame(1, 'a') + frame(2, 'b') + frame(0, 'heartbeat')),
      stream(frame(3, 'c')),
    ])
    const options = { baseUrl: served.url, token: 'tok', filter: {}, backoffMs: 10 }
    const numbers = seqNumbersUntil(subscribeEvents(options), (event) => event.seq === 3)
    await expect(numbers).resolves.toStrictEqual([1, 2, 0, 3])
    expect(served.requests.map((request) => request.lastEventId)).toStrictEqual([undefined, '2'])
  })

  it('counts an answer of 200 that is no event stream as a failed attempt', async () => {
    expect.hasAssertions()
    const proxied = await serve([page])
    const options = { baseUrl: proxied.url, token: 'tok', filter: {}, backoffMs: 10, retryFor: 200 }
    await expect(failureOf(options)).resolves.toMatchObject({ status: 0 })
  })

  it('starts the pauses and the time it may keep failing over once a connection opens', async () => {
    expect.hasAssertions()
    // Five failed attempts take about 300 ms, and so do four after the connection that opens between them
    const served = await serve([
      ...Array.from({ length: 5 }, () => broken),
      stream(frame(1, 'a')),
      ...Array.from({ length: 4 }, () => broken),
      stream(frame(2, 'b')),
    ])
    const options = { baseUrl: served.url, token: 'tok', filter: {}, backoffMs: 10, retryFor: 400 }
    const numbers = seqNumbersUntil(subscribeEvents(options), (event) => event.seq === 2)
    await expect(numbers).resolves.toStrictEqual([1, 2])
  })
})

describe('the refusals of a subscription', () => {
  it('stops at once with an ApiError that carries the problem of a 401', async () => {
    expect.hasAssertions()
    const denied = await serve([status(401, UNAUTHORIZED)])
    const failure = await failureOf({ baseUrl: denied.url, token: 'bad', filter: {} })
    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ status: 401, problem: { code: 'unauthorized' } })
    expect(denied.requests).toHaveLength(1)
  })

  it('stops at once with an ApiError on a 403 without a body', async () => {
    expect.hasAssertions()
    const denied = await serve([status(403)])
    const failure = await failureOf({ baseUrl: denied.url, token: 'tok', filter: {} })
    expect(failure).toMatchObject({ status: 403, problem: undefined })
    expect(denied.requests).toHaveLength(1)
  })

  it('gives up with an ApiError once reconnecting has failed for longer than retryFor', async () => {
    expect.hasAssertions()
    const gone = await serve([broken])
    const started = Date.now()
    const options = { baseUrl: gone.url, token: 'tok', filter: {}, backoffMs: 10, retryFor: 300 }
    const failure = await failureOf(options)
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ status: 0, url: `${gone.url}/api/v1/events` })
    expect(gone.requests.length).toBeGreaterThan(2)
  })
})

describe('the signal of a subscription', () => {
  it('ends quietly when the signal aborts', async () => {
    expect.hasAssertions()
    const served = await serve([stream(frame(1, 'a') + frame(2, 'b'), false)])
    const controller = new AbortController()
    const { signal } = controller
    const seen: number[] = []
    for await (const event of subscribeEvents({
      baseUrl: served.url,
      token: 'tok',
      filter: {},
      signal,
    })) {
      seen.push(event.seq)
      controller.abort()
    }
    expect(seen).toStrictEqual([1])
  })

  it('opens nothing when the signal has aborted already', async () => {
    expect.hasAssertions()
    const served = await serve([stream(frame(1, 'a'))])
    const signal = AbortSignal.abort()
    const events = subscribeEvents({ baseUrl: served.url, token: 'tok', filter: {}, signal })
    await expect(seqNumbersUntil(events, () => true)).resolves.toStrictEqual([])
    expect(served.requests).toHaveLength(0)
  })
})

describe('the signal of a subscription that waits', () => {
  it('ends quietly when the signal aborts while it waits for the next frame', async () => {
    expect.hasAssertions()
    const served = await serve([stream(frame(1, 'a'), false)])
    const controller = new AbortController()
    const { signal } = controller
    const seen: number[] = []
    for await (const event of subscribeEvents({
      baseUrl: served.url,
      token: 'tok',
      filter: {},
      signal,
    })) {
      seen.push(event.seq)
      setTimeout(() => {
        controller.abort()
      }, 20)
    }
    expect(seen).toStrictEqual([1])
    expect(served.requests).toHaveLength(1)
  })

  it('ends quietly when the signal aborts while it waits to reconnect', async () => {
    expect.hasAssertions()
    const gone = await serve([broken])
    const signal = AbortSignal.timeout(100)
    const started = Date.now()
    const options = { baseUrl: gone.url, token: 'tok', filter: {}, signal, backoffMs: 60_000 }
    await expect(seqNumbersUntil(subscribeEvents(options), () => true)).resolves.toStrictEqual([])
    expect(Date.now() - started).toBeLessThan(5000)
    expect(gone.requests).toHaveLength(1)
  })
})
