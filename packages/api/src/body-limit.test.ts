import { createTempRepo } from '@bytebureau/kernel/testing'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ApiTestLayer, authorized, baseUrl, get } from './testing.js'

const MEGABYTE = 1024 * 1024

// A body sent in chunks of a megabyte, with no length the check of the declared length could read
const chunked = (text: string): RequestInit => {
  const bytes = new TextEncoder().encode(text)
  const body = new ReadableStream<Uint8Array>({
    start: (controller): void => {
      for (let at = 0; at < bytes.length; at += MEGABYTE) {
        controller.enqueue(bytes.subarray(at, at + MEGABYTE))
      }
      controller.close()
    },
  })
  const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body }
  return Object.assign(authorized(init), { duplex: 'half' })
}

// The status the server answered with, or 0 when it cut the connection instead
const statusOf = (url: string, init: RequestInit): Effect.Effect<number> =>
  Effect.promise(async () => {
    try {
      const response = await fetch(url, init)
      await response.arrayBuffer()
      return response.status
    } catch {
      return 0
    }
  })

it.layer(ApiTestLayer())('the body limit and a body without a length', (suite) => {
  suite.effect('lets a small one through the check of the declared length to the endpoint', () =>
    Effect.gen(function* letsSmallThrough() {
      const base = yield* baseUrl
      const body = JSON.stringify({ path: createTempRepo() })
      assert.strictEqual(yield* statusOf(`${base}/api/v1/projects`, chunked(body)), 201)
    }),
  )

  suite.effect('leaves one over the limit to the platform, which takes nothing of it', () =>
    Effect.gen(function* cutsLarge() {
      const base = yield* baseUrl
      const repo = createTempRepo()
      // A valid body but for its length: trailing blanks are JSON
      const padded = `${JSON.stringify({ path: repo })}${' '.repeat(11 * MEGABYTE)}`
      const status = yield* statusOf(`${base}/api/v1/projects`, chunked(padded))
      const listed = yield* get('/projects')
      assert.notInclude([200, 201], status)
      assert.notInclude(JSON.stringify(listed.body), repo)
    }),
  )
})
