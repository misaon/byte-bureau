import type { AgentEvent } from '@bytebureau/protocol'
import { Latch } from 'effect'

type Result = IteratorResult<AgentEvent>

// Minimal async queue: producers push, the consumer iterates; end() finishes the iteration once the pushed events are read
export class EventQueue implements AsyncIterable<AgentEvent> {
  private readonly items: AgentEvent[] = []
  private readonly waiters: ((result: Result) => void)[] = []
  private closed = false
  // Opened once a reader has been told that there is nothing more to read, which is after it has read everything else
  public readonly finished = Latch.makeUnsafe()
  // Opened once a reader waits for an event that is not there yet
  public readonly reading = Latch.makeUnsafe()

  public push(...events: AgentEvent[]): void {
    for (const event of events) {
      const waiter = this.waiters.shift()
      if (waiter === undefined) {
        this.items.push(event)
      } else {
        waiter({ value: event, done: false })
      }
    }
  }

  public end(): void {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      Latch.openUnsafe(this.finished)
      waiter({ value: undefined, done: true })
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: async () => {
        const result = await this.next()
        return result
      },
    }
  }

  private async next(): Promise<Result> {
    const item = this.items.shift()
    if (item !== undefined) {
      return { value: item, done: false }
    }
    if (this.closed) {
      Latch.openUnsafe(this.finished)
      return { value: undefined, done: true }
    }
    const result = await this.wait()
    return result
  }

  // A read that waits until there is an event, or the end, to give
  private async wait(): Promise<Result> {
    const { promise, resolve } = Promise.withResolvers<Result>()
    this.waiters.push(resolve)
    Latch.openUnsafe(this.reading)
    const result = await promise
    return result
  }
}
