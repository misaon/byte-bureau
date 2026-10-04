import type { EventEnvelope } from '@bytebureau/protocol'

// What one client has not read yet: durable events are never dropped, ephemeral ones above the capacity push the oldest ephemeral out
export class DeliveryBuffer {
  public dropped = 0
  private items: EventEnvelope[] = []
  private ephemeral = 0
  private readonly capacity: number

  public constructor(capacity: number) {
    this.capacity = capacity
  }

  public push(event: EventEnvelope): void {
    this.items.push(event)
    if (event.seq === 0) {
      this.ephemeral += 1
      if (this.ephemeral > this.capacity) {
        this.evictOldestEphemeral()
      }
    }
  }

  public drain(): readonly EventEnvelope[] {
    const drained = this.items
    this.items = []
    this.ephemeral = 0
    return drained
  }

  private evictOldestEphemeral(): void {
    const index = this.items.findIndex((item) => item.seq === 0)
    this.items.splice(index, 1)
    this.ephemeral -= 1
    this.dropped += 1
  }
}
