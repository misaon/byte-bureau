import type { EventEnvelope } from '@bytebureau/protocol'

// An event in the order it came: the durable and the ephemeral ones wait apart and are merged again when they are taken
interface Arrival {
  readonly order: number
  readonly event: EventEnvelope
}

// The arrivals of both kinds in the order they came
const merged = (durable: readonly Arrival[], ephemeral: readonly Arrival[]): EventEnvelope[] =>
  [...durable, ...ephemeral]
    .toSorted((first, second) => first.order - second.order)
    .map((arrival) => arrival.event)

export interface DeliveryLimits {
  // Ephemeral events kept for a reader that lags: above it the oldest goes
  readonly capacity: number
  // Durable events a reader may lag behind: above it the reader is too slow for the stream
  readonly durable: number
}

/**
 * What one client has not read yet. Durable events are never dropped, but once more of them wait than the bound
 * allows the buffer says it has overflowed: the client's stream ends, and it resumes from its last id with a replay
 * from the log. Ephemeral events above the capacity push the oldest ephemeral one out, at a cost the backlog of
 * durable events does not change.
 */
export class DeliveryBuffer {
  public overflowed = false
  private dropped = 0
  private arrivals = 0
  private durable: Arrival[] = []
  private ephemeral: Arrival[] = []
  private readonly limits: DeliveryLimits

  public constructor(limits: DeliveryLimits) {
    this.limits = limits
  }

  public push(event: EventEnvelope): void {
    const arrival = { order: this.arrivals, event }
    this.arrivals += 1
    if (event.seq !== 0) {
      this.durable.push(arrival)
      this.overflowed ||= this.durable.length > this.limits.durable
      return
    }
    this.ephemeral.push(arrival)
    if (this.ephemeral.length > this.limits.capacity) {
      this.ephemeral.shift()
      this.dropped += 1
    }
  }

  public drain(): readonly EventEnvelope[] {
    const events = merged(this.durable, this.ephemeral)
    this.durable = []
    this.ephemeral = []
    return events
  }

  // The ephemeral events dropped since this was last asked
  public takeDropped(): number {
    const { dropped } = this
    this.dropped = 0
    return dropped
  }
}
