import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ApiTestLayer, baseUrl, fetched } from './testing.js'
import { connected } from './testing-ws.js'

const UI = 'http://ui.test'
const ELSEWHERE = 'http://evil.example'

// The body of an answer as text
const textOf = (response: Response): Effect.Effect<string> =>
  Effect.promise(async () => {
    const whole = await response.text()
    return whole
  })

// The Origin of a page and what the socket answers a plain GET from it: past the check it wants an Upgrade (400), else 403
const pagesOf = (port: string): [string, number][] => [
  [`http://localhost:${port}`, 400],
  [`http://127.0.0.1:${port}`, 400],
  ['http://localhost:1', 403],
  [ELSEWHERE, 403],
]

it.layer(ApiTestLayer())('the own page of the daemon at the upgrade of /api/v1/ws', (suite) => {
  suite.effect(
    'lets a page on a loopback name and the port of the daemon through, and no other',
    () =>
      Effect.gen(function* checksPages() {
        const base = yield* baseUrl
        const pages = pagesOf(new URL(base).port)
        const answers = yield* Effect.all(
          pages.map(([origin]) => fetched(`${base}/api/v1/ws`, { headers: { origin } })),
        )
        assert.deepStrictEqual(
          answers.map(({ status }) => status),
          pages.map(([, status]) => status),
        )
      }),
  )
})

it.layer(ApiTestLayer({ corsOrigins: [UI] }))(
  'the Origin a browser sends to /api/v1/ws',
  (suite) => {
    suite.effect('turns away an origin the daemon does not serve before the socket opens', () =>
      Effect.gen(function* refusesOrigin() {
        const base = yield* baseUrl
        const response = yield* fetched(`${base}/api/v1/ws`, { headers: { origin: ELSEWHERE } })
        assert.strictEqual(response.status, 403)
        assert.strictEqual(yield* textOf(response), '')
        const refused = yield* Effect.flip(connected({ origin: ELSEWHERE }))
        assert.include(refused.message, 'cannot open')
      }),
    )

    suite.effect('lets a listed origin open the socket', () =>
      Effect.gen(function* acceptsOrigin() {
        const client = yield* connected({ origin: UI })
        client.send({ _tag: 'Ping' })
        assert.deepStrictEqual(yield* client.next, { _tag: 'Pong' })
      }),
    )
  },
)
