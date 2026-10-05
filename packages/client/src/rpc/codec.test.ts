import { describe, expect, it } from 'vitest'
import { ApiError } from '../errors.js'
import {
  decodeFrame,
  encodeAck,
  encodeInterrupt,
  encodePing,
  encodeRequest,
  errorOf,
} from './codec.js'

const URL = 'ws://127.0.0.1:4747/api/v1/ws'

const RATE_LIMITED = {
  type: 'https://bytebureau.dev/problems/rate_limited',
  title: 'Too Many Requests',
  status: 429,
  detail: 'retry after 60 s',
  code: 'rate_limited',
}

describe('the RPC envelopes a client sends', () => {
  it('encodes a request with the token in its headers', () => {
    const request = { id: '1', tag: 'projects.register', payload: { path: '/r' }, token: 'tok' }
    expect(JSON.parse(encodeRequest(request))).toStrictEqual({
      _tag: 'Request',
      id: '1',
      tag: 'projects.register',
      payload: { path: '/r' },
      headers: [['authorization', 'Bearer tok']],
    })
  })

  it('encodes a request without a payload with null, as effect/rpc encodes void', () => {
    const request = { id: '2', tag: 'profiles.list', payload: undefined, token: 'tok' }
    expect(encodeRequest(request)).toContain('"payload":null')
  })

  it('encodes the ack, the interrupt and the ping', () => {
    expect(JSON.parse(encodeAck('1'))).toStrictEqual({ _tag: 'Ack', requestId: '1' })
    expect(JSON.parse(encodeInterrupt('1'))).toStrictEqual({ _tag: 'Interrupt', requestId: '1' })
    expect(JSON.parse(encodePing())).toStrictEqual({ _tag: 'Ping' })
  })
})

describe(decodeFrame, () => {
  it('decodes one message or a batch per frame', () => {
    const exit = { _tag: 'Exit', requestId: '1', exit: { _tag: 'Success', value: 'echo:hi' } }
    const chunk = { _tag: 'Chunk', requestId: '2', values: [1, 2, 3] }
    const defect = { _tag: 'Defect', defect: 'boom' }
    expect(decodeFrame(JSON.stringify(exit))).toStrictEqual([exit])
    expect(decodeFrame(JSON.stringify([chunk, { _tag: 'Pong' }]))).toStrictEqual([
      chunk,
      { _tag: 'Pong' },
    ])
    expect(decodeFrame(JSON.stringify(defect))).toStrictEqual([defect])
    const numbered = { _tag: 'Chunk', requestId: 2, values: [] }
    expect(decodeFrame(JSON.stringify(numbered))).toStrictEqual([numbered])
  })

  it('ignores what is not an envelope it knows', () => {
    expect(decodeFrame('{"nope":1}')).toStrictEqual([])
    expect(decodeFrame('not json')).toStrictEqual([])
    expect(decodeFrame('{"_tag":"Chunk","requestId":"2"}')).toStrictEqual([])
    expect(decodeFrame('{"_tag":"Exit","requestId":"1","exit":{"_tag":"Maybe"}}')).toStrictEqual([])
    expect(decodeFrame('[{"_tag":"Unknown"},{"_tag":"Pong"}]')).toStrictEqual([{ _tag: 'Pong' }])
  })
})

describe(errorOf, () => {
  it('fails with the problem the daemon said no with, as an ApiError', () => {
    const error = errorOf([{ _tag: 'Fail', error: RATE_LIMITED }], URL)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 429, problem: RATE_LIMITED, url: URL })
    expect(error.message).toBe('retry after 60 s (rate_limited)')
  })

  it('tells an interrupted request and a defect apart', () => {
    const interrupted = { _tag: 'Interrupt', fiberId: 195 }
    expect(errorOf([interrupted], URL).message).toBe('the request was interrupted')
    expect(errorOf([{ _tag: 'Die', defect: 'Unknown request tag: no.such' }], URL).message).toBe(
      'the daemon failed the request: Unknown request tag: no.such',
    )
    const died = errorOf([{ _tag: 'Die', defect: { name: 'Error', message: 'boom' } }], URL)
    expect(died.message).toBe('the daemon failed the request: boom')
  })

  it('tells a failure that carries no problem by what it carries, or says that it gave no reason', () => {
    expect(errorOf([{ _tag: 'Fail', error: 'not a problem' }], URL).message).toBe(
      'the daemon failed the request: not a problem',
    )
    expect(errorOf([{ _tag: 'Die', defect: 42 }], URL).message).toBe(
      'the daemon failed the request: no reason given',
    )
    expect(errorOf([], URL).message).toBe('the daemon failed the request: no reason given')
  })
})
