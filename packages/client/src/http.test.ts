import { describe, expect, it } from 'vitest'
import { ApiError } from './errors.js'
import { createBureauClient } from './index.js'
import { frame, serve, status, stream } from './sse-fixture.js'

// What a call of the client was refused with
const failureOf = async (call: Promise<unknown>): Promise<unknown> => {
  try {
    await call
  } catch (error) {
    return error
  }
  return 'not refused'
}

const CONFLICT = {
  type: 'https://bytebureau.dev/problems/session_invalid_transition',
  title: 'Conflict',
  status: 409,
  detail: 'cannot stop a completed session',
  code: 'session_invalid_transition',
}

const INTERNAL = {
  type: 'https://bytebureau.dev/problems/internal',
  title: 'Internal Server Error',
  status: 500,
  detail: 'unexpected failure',
  code: 'internal',
}

describe(createBureauClient, () => {
  it('throws the problem of an answer as an ApiError that names the request, with the bearer token sent', async () => {
    expect.hasAssertions()
    const served = await serve([status(409, CONFLICT)])
    const client = createBureauClient({ baseUrl: served.url, token: 'tok' })
    const failure = await failureOf(client.sessions.stop('s1'))
    expect(failure).toBeInstanceOf(ApiError)
    const url = `${served.url}/api/v1/sessions/s1/stop`
    expect(failure).toMatchObject({ status: 409, problem: CONFLICT, url })
    expect(served.requests).toMatchObject([
      { url: '/api/v1/sessions/s1/stop', authorization: 'Bearer tok' },
    ])
  })

  it('throws an answer without a problem as an ApiError of its status', async () => {
    expect.hasAssertions()
    const served = await serve([status(502)])
    const failure = await failureOf(
      createBureauClient({ baseUrl: served.url, token: 'tok' }).projects.list(),
    )
    expect(failure).toMatchObject({ status: 502, problem: undefined })
    expect(failure).toHaveProperty('message', 'the daemon answered 502')
  })

  it('throws a 2xx answer without the data a query needs as an ApiError of its status', async () => {
    expect.hasAssertions()
    const served = await serve([status(204)])
    const failure = await failureOf(
      createBureauClient({ baseUrl: served.url, token: 'tok' }).projects.list(),
    )
    expect(failure).toMatchObject({ status: 204, problem: undefined })
  })
})

describe('the lookups and the close of a client', () => {
  it('reads a lookup the daemon answers 404 as undefined, and throws any other refusal', async () => {
    expect.hasAssertions()
    const served = await serve([status(404), status(500, INTERNAL)])
    const client = createBureauClient({ baseUrl: served.url, token: 'tok' })
    await expect(client.sessions.get('s1')).resolves.toBeUndefined()
    await expect(client.sessions.get('s1')).rejects.toMatchObject({
      status: 500,
      problem: INTERNAL,
    })
  })

  it('joins the paths to a base url that ends with a slash', async () => {
    expect.hasAssertions()
    const served = await serve([status(404), stream(frame(1, 'a'))])
    const client = createBureauClient({ baseUrl: `${served.url}/`, token: 'tok' })
    await expect(client.projects.get('p1')).resolves.toBeUndefined()
    for await (const event of client.events.subscribe({})) {
      expect(event.seq).toBe(1)
      break
    }
    expect(served.requests.map((request) => request.url)).toStrictEqual([
      '/api/v1/projects/p1',
      '/api/v1/events',
    ])
  })

  it('closes without anything to release', async () => {
    expect.hasAssertions()
    await expect(
      createBureauClient({ baseUrl: 'http://127.0.0.1:1', token: 'tok' }).close(),
    ).resolves.toBeUndefined()
  })
})
