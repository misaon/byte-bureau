type Enqueue = <Result>(key: string, work: () => Promise<Result>) => Promise<Result>

async function afterwards<Result>(
  before: Promise<unknown>,
  work: () => Promise<Result>,
): Promise<Result> {
  try {
    await before
  } catch {
    // The caller of the earlier work gets to see how it went wrong
  }
  return work()
}

// A queue per key: the work of one key runs one piece after the other, in the order it came; other keys go their own way
export function createKeyedQueue(): Enqueue {
  const turns = new Map<string, Promise<unknown>>()
  return async (key, work) => {
    const mine = afterwards(turns.get(key) ?? Promise.resolve(), work)
    turns.set(key, mine)
    const result = await mine
    return result
  }
}
