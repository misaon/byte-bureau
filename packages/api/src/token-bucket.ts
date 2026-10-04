export interface TokenBucketOptions {
  readonly capacity: number
  readonly perMinute: number
  // Milliseconds; injectable so tests move time by hand
  readonly now: () => number
}

export interface Verdict {
  readonly allowed: boolean
  readonly retryAfterSec: number
}

interface Bucket {
  readonly tokens: number
  readonly updatedAt: number
}

const MS_PER_MINUTE = 60_000

// A token bucket per key: a call takes a token, tokens flow back at a steady rate, a full bucket is forgotten
export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>()
  private readonly options: TokenBucketOptions

  public constructor(options: TokenBucketOptions) {
    this.options = options
  }

  public take(key: string): Verdict {
    const now = this.options.now()
    this.forgetFull(now)
    const known = this.buckets.get(key)
    const tokens = known === undefined ? this.options.capacity : this.refilled(known, now)
    if (tokens >= 1) {
      this.buckets.set(key, { tokens: tokens - 1, updatedAt: now })
      return { allowed: true, retryAfterSec: 0 }
    }
    const perMs = this.options.perMinute / MS_PER_MINUTE
    return { allowed: false, retryAfterSec: Math.ceil((1 - tokens) / perMs / 1000) }
  }

  public size(): number {
    return this.buckets.size
  }

  // The tokens of a bucket with what flowed back since it was last taken from, at most the capacity
  private refilled(bucket: Bucket, now: number): number {
    const flowed = ((now - bucket.updatedAt) * this.options.perMinute) / MS_PER_MINUTE
    return Math.min(this.options.capacity, bucket.tokens + flowed)
  }

  // A full bucket is the same as none, so the map keeps only the clients that called lately
  private forgetFull(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (this.refilled(bucket, now) >= this.options.capacity) {
        this.buckets.delete(key)
      }
    }
  }
}
