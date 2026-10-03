import type { AgentEvent } from '@bytebureau/protocol'

type Result = IteratorResult<AgentEvent>

// Minimal async queue: producers push, the consumer iterates; end() finishes the iteration once the pushed events are read
export class EventQueue implements AsyncIterable<AgentEvent> {
  private readonly items: AgentEvent[] = []
  private readonly waiters: ((result: Result) => void)[] = []
  private closed = false

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

  // How many events have been pushed and not read yet
  public get pending(): number {
    return this.items.length
  }

  public end(): void {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
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
      return { value: undefined, done: true }
    }
    const { promise, resolve } = Promise.withResolvers<Result>()
    this.waiters.push(resolve)
    const result = await promise
    return result
  }
}
