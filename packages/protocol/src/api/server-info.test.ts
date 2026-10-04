import { describe, expect, it } from 'vitest'
import { decodeServerInfo, serverUrl } from './server-info.js'

const info = {
  version: '0.1.0',
  host: '127.0.0.1',
  port: 4747,
  pid: 4242,
  token: 'test-token',
  startedAt: '2026-10-04T10:00:00.000Z',
}

describe(serverUrl, () => {
  it('names an IPv4 host as it is and brackets an IPv6 host', () => {
    expect(serverUrl(info)).toBe('http://127.0.0.1:4747')
    expect(serverUrl({ host: '::1', port: 4747 })).toBe('http://[::1]:4747')
  })
})

describe(decodeServerInfo, () => {
  it('reads the record of the server file', () => {
    expect(decodeServerInfo(info)).toStrictEqual(info)
  })

  it('refuses a record with a field it does not know or without one it needs', () => {
    expect(() => decodeServerInfo({ ...info, extra: 1 })).toThrow(/extra/u)
    expect(() => decodeServerInfo({ ...info, token: undefined })).toThrow(/token/u)
  })
})
