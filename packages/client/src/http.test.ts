import { describe, expect, it } from 'vitest'
import { ApiError } from './errors.js'
import { createBureauClient } from './index.js'
import { frame, json, serve, status, stream, type Served } from './sse-fixture.js'

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

  it('joins the paths to a base url that ends with slashes, however many', async () => {
    expect.hasAssertions()
    const served = await serve([status(404), stream(frame(1, 'a'))])
    const client = createBureauClient({ baseUrl: `${served.url}////`, token: 'tok' })
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

const AT = '2026-10-05T00:00:00.000Z'

const PROFILE = {
  id: 'fake/work',
  providerId: 'fake',
  name: 'work',
  kind: 'login',
  configDir: '/home/me/.bytebureau/profiles/fake/work',
  isDefault: true,
  createdAt: AT,
}

const CHECKED = { profileId: 'fake/work', state: 'loggedIn', checkedAt: AT }
const SNAPSHOT = { profileId: 'fake/work', rateLimit: { fiveHourPct: 40 }, observedAt: AT }

const GONE = {
  type: 'https://bytebureau.dev/problems/profile_not_found',
  title: 'Not Found',
  status: 404,
  detail: 'no profile "fake/nope"',
  code: 'profile_not_found',
}

// The method and the request target of each request, as the daemon got them over the wire
const wireOf = (served: Served): string[][] =>
  served.requests.map((request) => [request.method, request.target])

describe('the profiles of a client', () => {
  it('adds a profile by posting its body, and reads the profile the daemon answers with', async () => {
    expect.hasAssertions()
    const served = await serve([json(201, PROFILE)])
    const client = createBureauClient({ baseUrl: served.url, token: 'tok' })
    const body = { providerId: 'fake', name: 'work', kind: 'login', makeDefault: true } as const
    await expect(client.profiles.add(body)).resolves.toStrictEqual(PROFILE)
    expect(served.requests).toMatchObject([
      { method: 'POST', target: '/api/v1/profiles', body: JSON.stringify(body) },
    ])
    expect(served.requests.map((request) => request.authorization)).toStrictEqual(['Bearer tok'])
  })

  it('removes a profile by its id in one path segment, with the purge in the query when given', async () => {
    expect.hasAssertions()
    const served = await serve([status(204)])
    const client = createBureauClient({ baseUrl: served.url, token: 'tok' })
    await client.profiles.remove('fake/work', { purge: true })
    await client.profiles.remove('fake/work', { purge: false })
    await client.profiles.remove('fake/work')
    expect(wireOf(served)).toStrictEqual([
      ['DELETE', '/api/v1/profiles/fake%2Fwork?purge=true'],
      ['DELETE', '/api/v1/profiles/fake%2Fwork?purge=false'],
      ['DELETE', '/api/v1/profiles/fake%2Fwork'],
    ])
  })

  it('throws the refusal of a profile as an ApiError with its problem, not as nothing', async () => {
    expect.hasAssertions()
    const served = await serve([status(404, GONE)])
    const client = createBureauClient({ baseUrl: served.url, token: 'tok' })
    await expect(client.profiles.status('fake/nope')).rejects.toMatchObject({
      status: 404,
      problem: GONE,
    })
    await expect(client.profiles.remove('fake/nope')).rejects.toMatchObject({
      status: 404,
      problem: GONE,
    })
  })
})

describe('the paths of the profile calls of a client', () => {
  it('names a profile by its encoded id in the paths of its default, its status and its usage', async () => {
    expect.hasAssertions()
    const answers = [status(204), json(200, CHECKED), json(200, SNAPSHOT), json(200, [PROFILE])]
    const served = await serve(answers)
    const client = createBureauClient({ baseUrl: served.url, token: 'tok' })
    await client.profiles.setDefault('fake/work')
    await expect(client.profiles.status('fake/work')).resolves.toStrictEqual(CHECKED)
    await expect(client.usage.profile('fake/work')).resolves.toStrictEqual(SNAPSHOT)
    await expect(client.profiles.list()).resolves.toStrictEqual([PROFILE])
    expect(wireOf(served)).toStrictEqual([
      ['POST', '/api/v1/profiles/fake%2Fwork/default'],
      ['GET', '/api/v1/profiles/fake%2Fwork/status'],
      ['GET', '/api/v1/usage/profiles/fake%2Fwork'],
      ['GET', '/api/v1/profiles'],
    ])
  })
})
