import { describe, expect, it } from 'vitest'
import { TokenBuckets } from './token-bucket.js'

describe(TokenBuckets, () => {
  it('allows capacity calls at once, refuses the next and says when to retry', () => {
    const buckets = new TokenBuckets({ capacity: 3, perMinute: 60 })
    expect(buckets.take('a', 0)).toStrictEqual({ allowed: true, retryAfterSec: 0 })
    buckets.take('a', 0)
    buckets.take('a', 0)
    expect(buckets.take('a', 0)).toStrictEqual({ allowed: false, retryAfterSec: 1 })
    expect(buckets.take('a', 1000)).toStrictEqual({ allowed: true, retryAfterSec: 0 })
  })

  it('keeps one bucket per key and forgets a key that is full again', () => {
    const buckets = new TokenBuckets({ capacity: 1, perMinute: 60 })
    buckets.take('a', 0)
    expect(buckets.take('b', 0)).toStrictEqual({ allowed: true, retryAfterSec: 0 })
    expect(buckets.size()).toBe(2)
    buckets.take('a', 60_000)
    expect(buckets.size()).toBe(1)
  })

  it('takes no tokens away and keeps refilling when the clock steps back', () => {
    const buckets = new TokenBuckets({ capacity: 1, perMinute: 60 })
    buckets.take('a', 60_000)
    expect(buckets.take('a', 0)).toStrictEqual({ allowed: false, retryAfterSec: 1 })
    expect(buckets.take('a', 1000)).toStrictEqual({ allowed: true, retryAfterSec: 0 })
  })
})
