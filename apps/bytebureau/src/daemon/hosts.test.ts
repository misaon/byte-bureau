import { describe, expect, it } from 'vitest'
import { clientHost, isLoopback } from './hosts.js'

describe(isLoopback, () => {
  it('tells the loopback names and addresses from those the network reaches', () => {
    const loopback = ['127.0.0.1', '127.0.0.2', 'localhost', '::1']
    const network = ['0.0.0.0', '::', '192.168.1.5', '10.0.0.5', 'example.com']
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
