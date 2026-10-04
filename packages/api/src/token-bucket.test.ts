import { describe, expect, it } from 'vitest'
import { TokenBuckets } from './token-bucket.js'

describe(TokenBuckets, () => {
  it('allows capacity calls at once, refuses the next and says when to retry', () => {
    let now = 0
    const buckets = new TokenBuckets({ capacity: 3, perMinute: 60, now: (): number => now })
    expect(buckets.take('a')).toStrictEqual({ allowed: true, retryAfterSec: 0 })
    buckets.take('a')
    buckets.take('a')
    expect(buckets.take('a')).toStrictEqual({ allowed: false, retryAfterSec: 1 })
    now = 1000
    expect(buckets.take('a')).toStrictEqual({ allowed: true, retryAfterSec: 0 })
  })

  it('keeps one bucket per key and forgets a key that is full again', () => {
    let now = 0
    const buckets = new TokenBuckets({ capacity: 1, perMinute: 60, now: (): number => now })
    buckets.take('a')
    expect(buckets.take('b')).toStrictEqual({ allowed: true, retryAfterSec: 0 })
    expect(buckets.size()).toBe(2)
    now = 60_000
    buckets.take('a')
    expect(buckets.size()).toBe(1)
  })
})
