// Values pushed by one side and read in order by the other; end() lets the reader finish once it has read the rest
export class Queue<Item extends object> implements AsyncIterable<Item> {
  private readonly items: Item[] = []
  private readonly waiting: ((result: IteratorResult<Item, undefined>) => void)[] = []
  private ended = false

  public push(item: Item): void {
    if (this.ended) {
      return
    }
    const reader = this.waiting.shift()
    if (reader === undefined) {
      this.items.push(item)
    } else {
      reader({ value: item, done: false })
    }
  }

  public end(): void {
    this.ended = true
    for (const reader of this.waiting.splice(0)) {
      reader({ value: undefined, done: true })
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<Item, undefined> {
    return {
      next: async () => {
        const result = await this.next()
        return result
      },
    }
  }

  private async next(): Promise<IteratorResult<Item, undefined>> {
    const item = this.items.shift()
    if (item !== undefined) {
      return { value: item, done: false }
    }
    if (this.ended) {
      return { value: undefined, done: true }
    }
    const { promise, resolve } = Promise.withResolvers<IteratorResult<Item, undefined>>()
    this.waiting.push(resolve)
    const result = await promise
    return result
  }
}
