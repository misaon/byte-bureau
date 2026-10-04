import { describe, expect, it } from 'vitest'
import { boundAddress } from './bun-address.js'

describe(boundAddress, () => {
  it('reads host and port from a URL and from a bare address', () => {
    expect(boundAddress('http://127.0.0.1:4747')).toStrictEqual({ host: '127.0.0.1', port: 4747 })
    expect(boundAddress('127.0.0.1:51234')).toStrictEqual({ host: '127.0.0.1', port: 51_234 })
    expect(boundAddress('http://[::1]:4747')).toStrictEqual({ host: '::1', port: 4747 })
  })

  it('keeps port 80, which a URL leaves out as the default of its scheme', () => {
    expect(boundAddress('http://127.0.0.1:80')).toStrictEqual({ host: '127.0.0.1', port: 80 })
  })
})
