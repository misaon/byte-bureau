import { Headers } from 'effect/http'
import { describe, expect, it } from 'vitest'
import { originAllowed } from './origin.js'

const LISTED = ['http://ui.test']

// The daemon on its usual port, reached at the IPv4 loopback
const HOST = '127.0.0.1:4747'

// The headers of an upgrade from a page to that daemon
const from = (origin: string): Record<string, string> => ({ origin, host: HOST })

// The headers of an upgrade and whether a browser that sent them may open the socket
const DECIDED: [string, Record<string, string>, boolean][] = [
  ['no Origin', { host: HOST }, true],
  ['a listed origin', from('http://ui.test'), true],
  ['the own page on localhost', from('http://localhost:4747'), true],
  ['the own page on 127.0.0.1', { origin: 'http://127.0.0.1:4747', host: 'localhost:4747' }, true],
  ['the own page on [::1]', { origin: 'http://[::1]:4747', host: '[::1]:4747' }, true],
  ['a loopback page on another port', from('http://localhost:1'), false],
  [
    'a page that rebound its own name to the loopback',
    { origin: 'http://attacker.example:4747', host: 'attacker.example:4747' },
    false,
  ],
  [
    'an https page against a daemon on port 80',
    { origin: 'https://localhost', host: 'localhost' },
    false,
  ],
  ['a page of another site', from('http://evil.example'), false],
  ['an opaque origin', from('null'), false],
  ['an empty Origin', from(''), false],
  ['a loopback page without a Host', { origin: 'http://localhost:4747' }, false],
  [
    'a loopback page and a Host that is no host',
    { origin: 'http://localhost:4747', host: 'no host' },
    false,
  ],
  ['a loopback origin of another scheme', from('ftp://localhost'), false],
]

describe(originAllowed, () => {
  it.each(DECIDED)('decides on %s', (name, headers, allowed) => {
    expect(originAllowed(Headers.fromInput(headers), LISTED), name).toBe(allowed)
  })
})
