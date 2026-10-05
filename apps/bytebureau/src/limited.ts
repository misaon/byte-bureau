interface Queued<Item> {
  readonly item: Item
  readonly index: number
}

// One lane takes the next item once its last one is done; once an item fails, no lane starts another
async function lane<Item, Result>(
  queue: Queued<Item>[],
  work: (item: Item) => Promise<Result>,
  results: Result[],
): Promise<void> {
  const next = queue.shift()
  if (next === undefined) {
    return
  }
  try {
    results[next.index] = await work(next.item)
  } catch (error) {
    queue.splice(0)
    throw error
  }
  await lane(queue, work, results)
}

// The work done on every item, in the order of the items, with at most limit of them under way at once
export async function mapLimited<Item, Result>(
  items: readonly Item[],
  limit: number,
  work: (item: Item) => Promise<Result>,
): Promise<readonly Result[]> {
  const queue = items.map((item, index) => ({ item, index }))
  const results: Result[] = []
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    await lane(queue, work, results)
  })
  await Promise.all(lanes)
  return results
}
