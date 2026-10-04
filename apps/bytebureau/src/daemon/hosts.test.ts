import { describe, expect, it } from 'vitest'
import { clientHost, isLoopback } from './hosts.js'

describe(isLoopback, () => {
  it('tells the loopback names and addresses from those the network reaches', () => {
    const loopback = ['127.0.0.1', '127.0.0.2', 'localhost', 'LocalHost', '::1', '[::1]']
    const network = ['0.0.0.0', '::', '192.168.1.5', '10.0.0.5', 'example.com', '127.example.com']
    expect(loopback.filter((host) => !isLoopback(host))).toStrictEqual([])
    expect(network.filter((host) => isLoopback(host))).toStrictEqual([])
  })

  it('knows the loopback in every way IPv6 writes it', () => {
    const loopback = [
      '0:0:0:0:0:0:0:1',
      '::0:1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::FFFF:127.1.2.3',
    ]
    const network = ['::2', '::ffff:192.168.1.5', 'fe80::1', '::ffff:10.0.0.1']
    expect(loopback.filter((host) => !isLoopback(host))).toStrictEqual([])
    expect(network.filter((host) => isLoopback(host))).toStrictEqual([])
  })
})

describe(clientHost, () => {
  it('records the loopback of the same family for a daemon bound to every interface', () => {
    expect(clientHost('0.0.0.0')).toBe('127.0.0.1')
    expect(clientHost('::')).toBe('::1')
  })

  it('records any other address as it was bound', () => {
    const bound = ['127.0.0.1', '::1', '192.168.1.5', 'fe80::1']
    expect(bound.map((host) => clientHost(host))).toStrictEqual(bound)
  })
})
