// What a stream offers to tell that it has taken in what was written to it
interface Sink {
  readonly write: (chunk: string, taken: () => void) => boolean
}

// Bun writes to a pipe asynchronously: an exit that does not wait for the writes would lose the last lines of NDJSON
// Without a limit the wait lasts as long as the reader takes, a pager too; with one it ends then, so an exit that must happen does
export async function drained(stream: Sink, limitMs?: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const timer = limitMs === undefined ? undefined : setTimeout(resolve, limitMs, false)
  stream.write('', () => {
    resolve(true)
  })
  await promise
  clearTimeout(timer)
}
