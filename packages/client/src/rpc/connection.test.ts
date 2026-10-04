import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { connectRpc } from './connection.js'
import type { SocketLike } from './link.js'

const URL = 'ws://127.0.0.1:4747/api/v1/ws'

// The sockets a test opened, the last one last
const opened: FakeSocket[] = []

// A socket that opens at once, keeps what the connection sends and delivers what the test says the daemon sends
class FakeSocket implements SocketLike {
  public readonly sent: unknown[] = []
  public closing = false
  private readonly listeners: {
    readonly type: string
    readonly listener: (event: Event) => void
  }[] = []

  public constructor() {
    opened.push(this)
    queueMicrotask(() => {
      this.emit(new Event('open'))
    })
  }

  public readonly addEventListener = (type: string, listener: (event: Event) => void): void => {
    this.listeners.push({ type, listener })
  }

  public readonly send = (data: string): void => {
    const message: unknown = JSON.parse(data)
    this.sent.push(message)
  }

  // A real socket tells it has closed only after the closing handshake, which a peer that is gone never answers
  public readonly close = (): void => {
    this.closing = true
  }

  public readonly receive = (message: object): void => {
    this.emit(new MessageEvent('message', { data: JSON.stringify(message) }))
  }

  private emit(event: Event): void {
    for (const { type, listener } of this.listeners) {
      if (type === event.type) {
        listener(event)
      }
    }
  }
}

const lastSocket = (): FakeSocket => {
  const socket = opened.at(-1)
  if (socket === undefined) {
    throw new Error('no socket was opened')
  }
  return socket
}

const tagOf = (message: unknown): unknown => {
  const tag: unknown =
    typeof message === 'object' && message !== null ? Reflect.get(message, '_tag') : undefined
  return tag
}

const tagsOf = (socket: FakeSocket): unknown[] => socket.sent.map((message) => tagOf(message))

// The reader of a stream of a fresh connection that has taken the first value of the chunk the daemon sends
async function readingFirst(
  values: readonly string[],
  signal?: AbortSignal,
): Promise<{ readonly reading: AsyncIterator<unknown>; readonly socket: FakeSocket }> {
  const connection = await connectRpc({ url: URL, token: 'tok', WebSocket: FakeSocket })
  onTestFinished(() => {
    connection.close()
  })
  const reading = connection.stream('events.subscribe', {}, signal)[Symbol.asyncIterator]()
  const first = reading.next()
  const socket = lastSocket()
  socket.receive({ _tag: 'Chunk', requestId: '1', values })
  await first
  return { reading, socket }
}

describe('the pings of an RPC connection', () => {
  it('pings while the connection is open, and drops its timer when closed, before the socket says so', async () => {
    expect.hasAssertions()
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const options = { url: URL, token: 'tok', WebSocket: FakeSocket, pingMs: 10 }
    const connection = await connectRpc(options)
    vi.advanceTimersByTime(35)
    connection.close()
    vi.advanceTimersByTime(100)
    expect([tagsOf(lastSocket()), lastSocket().closing]).toStrictEqual([
      ['Ping', 'Ping', 'Ping'],
      true,
    ])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('a stream of an RPC connection and its signal', () => {
  it('interrupts the request at once when the signal aborts, and acknowledges nothing after', async () => {
    expect.hasAssertions()
    const controller = new AbortController()
    const { reading, socket } = await readingFirst(['a', 'b'], controller.signal)
    controller.abort()
    // Interrupted before the reader asks for more
    const atTheAbort = tagsOf(socket)
    await expect(reading.next()).resolves.toStrictEqual({ done: true, value: undefined })
    expect([atTheAbort, tagsOf(socket)]).toStrictEqual([
      ['Request', 'Interrupt'],
      ['Request', 'Interrupt'],
    ])
  })

  it('acknowledges a chunk once all its values have been read', async () => {
    expect.hasAssertions()
    const { reading, socket } = await readingFirst(['a'])
    const second = reading.next()
    socket.receive({ _tag: 'Exit', requestId: '1', exit: { _tag: 'Success' } })
    await expect(second).resolves.toStrictEqual({ done: true, value: undefined })
    expect(tagsOf(socket)).toStrictEqual(['Request', 'Ack'])
  })
})
