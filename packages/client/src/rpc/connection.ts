import { ApiError } from '../errors.js'
import { encodeAck, encodePing, errorOf, type ExitMessage } from './codec.js'
import { Link, type Exchange, type RequestMessage, type Stop } from './link.js'

export interface RpcOptions {
  // The url of the socket: ws://<host>:<port>/api/v1/ws
  readonly url: string
  readonly token: string
  // The constructor to open the socket with; the global WebSocket by default
  readonly WebSocket?: typeof WebSocket | undefined
  readonly pingMs?: number | undefined
}

export interface RpcConnection {
  // Runs a procedure: the value of its exit, or its problem as an ApiError
  readonly call: (tag: string, payload: unknown) => Promise<unknown>
  // Runs a streaming procedure: every value of every chunk, until the daemon ends it or the signal aborts
  readonly stream: (tag: string, payload: unknown, signal?: AbortSignal) => AsyncIterable<unknown>
  // Closes the socket; a request still open fails
  readonly close: () => void
}

interface StreamRequest {
  readonly tag: string
  readonly payload: unknown
  readonly signal: AbortSignal | undefined
}

const PING_MS = 30_000

const STOPPED: Stop = { _tag: 'Stop', error: undefined }

// The end of a request: a failed exit or a closed connection throws, a success or a stop by its caller returns
const settle = (message: ExitMessage | Stop, url: string): unknown => {
  if ('error' in message) {
    if (message.error !== undefined) {
      throw message.error
    }
    return undefined
  }
  if ('cause' in message.exit) {
    throw errorOf(message.exit.cause, url)
  }
  return message.exit.value
}

const answerOf = (message: RequestMessage, url: string): unknown => {
  if ('values' in message) {
    throw new Error('the daemon answered a call with a stream')
  }
  return settle(message, url)
}

const called = async (link: Link, tag: string, payload: unknown): Promise<unknown> => {
  const exchange = link.open(tag, payload)
  const message = await exchange.inbox.take()
  exchange.release()
  return answerOf(message, link.url)
}

function* untilAborted(values: readonly unknown[], signal: AbortSignal): Generator {
  for (const value of values) {
    if (signal.aborted) {
      return
    }
    yield value
  }
}

// Each chunk is acknowledged once its values are taken, so the daemon sends the next one only as fast as they are read
async function* valuesOf(link: Link, exchange: Exchange, signal: AbortSignal): AsyncGenerator {
  for await (const message of exchange.inbox) {
    if (!('values' in message)) {
      settle(message, link.url)
      return
    }
    yield* untilAborted(message.values, signal)
    link.send(encodeAck(exchange.id))
  }
}

// Leaving early, or an aborted signal, interrupts the request on the daemon
async function* streamed(link: Link, { tag, payload, signal }: StreamRequest): AsyncGenerator {
  const watched = signal ?? new AbortController().signal
  if (watched.aborted) {
    return
  }
  const exchange = link.open(tag, payload)
  const stop = (): void => {
    exchange.inbox.push(STOPPED)
  }
  watched.addEventListener('abort', stop, { once: true })
  try {
    yield* valuesOf(link, exchange, watched)
  } finally {
    watched.removeEventListener('abort', stop)
    exchange.release()
  }
}

// Resolves once the socket is open; a socket that fails or closes first is a daemon that cannot be reached
const opened = async (socket: WebSocket, url: string): Promise<boolean> => {
  const { promise, resolve, reject } = Promise.withResolvers<boolean>()
  const unreachable = (): void => {
    reject(new ApiError(0, undefined, url))
  }
  socket.addEventListener(
    'open',
    () => {
      resolve(true)
    },
    { once: true },
  )
  socket.addEventListener('error', unreachable, { once: true })
  socket.addEventListener('close', unreachable, { once: true })
  const open = await promise
  return open
}

/**
 * Opens the effect/rpc connection of the daemon at the url: every request carries the bearer token in its headers,
 * streams are acknowledged chunk by chunk, and the connection pings while it is open.
 * Rejects with an ApiError of status 0 when the socket does not open.
 */
export async function connectRpc(options: RpcOptions): Promise<RpcConnection> {
  const { url, token, WebSocket: Socket = WebSocket, pingMs = PING_MS } = options
  const socket = new Socket(url)
  const link = new Link(socket, url, token)
  await opened(socket, url)
  const ping = setInterval(() => {
    link.send(encodePing())
  }, pingMs)
  socket.addEventListener('close', () => {
    clearInterval(ping)
  })
  return {
    call: async (tag, payload) => {
      const answer = await called(link, tag, payload)
      return answer
    },
    stream: (tag, payload, signal) => streamed(link, { tag, payload, signal }),
    close: () => {
      link.close(new Error('the connection is closed'))
    },
  }
}
