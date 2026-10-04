// What a stream offers to tell that it has taken in what was written to it
interface Sink {
  readonly isTTY?: boolean | undefined
  readonly write: (chunk: string, taken: () => void) => boolean
  readonly end: (taken: () => void) => unknown
}

/**
 * Bun writes to a pipe asynchronously: an exit that does not wait for the writes would lose the last lines of NDJSON.
 * A pipe or a file is ended, which waits for every write before it: Bun calls an empty write back at once, whatever is
 * still on its way. A terminal takes what is written as it comes, and is never ended.
 * Without a limit the wait lasts as long as the reader takes, a pager too; with one it ends then, so an exit that must happen does.
 */
export async function drained(stream: Sink, limitMs?: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const timer = limitMs === undefined ? undefined : setTimeout(resolve, limitMs, false)
  const taken = (): void => {
    resolve(true)
  }
  if (stream.isTTY === true) {
    stream.write('', taken)
  } else {
    stream.end(taken)
  }
  await promise
  clearTimeout(timer)
}
