import { describe, expect, it } from 'vitest'
import { ApiError, isProblem } from './errors.js'

const notFound = {
  type: 'https://bytebureau.dev/problems/session_not_found',
  title: 'Not Found',
  status: 404,
  detail: 'no session 42',
  code: 'session_not_found',
}

describe(ApiError, () => {
  it('tells a problem by its detail and code', () => {
    const error = new ApiError(404, notFound)
    expect(error.message).toBe('no session 42 (session_not_found)')
    expect(error.status).toBe(404)
    expect(error.problem).toStrictEqual(notFound)
  })

  it('is an Error named ApiError that keeps the url of the request', () => {
    const error = new ApiError(404, notFound, 'http://127.0.0.1:4747/api/v1/sessions/42')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ApiError')
    expect(error.url).toBe('http://127.0.0.1:4747/api/v1/sessions/42')
  })

  it('tells an unreachable daemon by its url and an unknown answer by its status', () => {
    expect(new ApiError(0, undefined, 'http://127.0.0.1:1/api/v1/health').message).toBe(
      'cannot reach the daemon at http://127.0.0.1:1/api/v1/health',
    )
    expect(new ApiError(502, undefined).message).toBe('the daemon answered 502')
    expect(new ApiError(0, undefined).message).toBe('cannot reach the daemon at an unknown url')
  })

  it('keeps what a request that got no answer failed with', () => {
    const cause = new TypeError('fetch failed')
    const error = new ApiError(0, undefined, { url: 'http://127.0.0.1:1/api/v1/health', cause })
    expect(error.message).toBe('cannot reach the daemon at http://127.0.0.1:1/api/v1/health')
    expect(error.url).toBe('http://127.0.0.1:1/api/v1/health')
    expect(error.cause).toBe(cause)
    expect(Object.hasOwn(new ApiError(502, undefined), 'cause')).toBe(false)
  })
})

describe(isProblem, () => {
  it.each([
    ['a problem', notFound, true],
    ['a problem with an instance', { ...notFound, instance: '/api/v1/sessions/42' }, true],
    ['a status that is not a number', { ...notFound, status: '404' }, false],
    ['an object without a detail', { code: 'session_not_found', status: 404 }, false],
    ['a text', 'no session 42', false],
    ['null', JSON.parse('null'), false],
  ])('tells %s', (_name, value, expected) => {
    expect(isProblem(value)).toBe(expected)
  })
})
