import { EventEnvelope } from '@bytebureau/protocol'
import { Effect, Queue, Schema, type Cause, type Scope } from 'effect'
import type { HttpServer } from 'effect/http'
import { WS_PATH } from './rpc/group.js'
import { baseUrl } from './testing.js'

// One envelope of effect/rpc as it travels: Request, Ack, Interrupt, Ping from the client; Chunk, Exit, Defect, Pong from the server
export interface WsMessage {
  readonly _tag: string
  readonly [key: string]: unknown
}

const isMessage = (item: unknown): item is WsMessage =>
  typeof item === 'object' && item !== null && typeof Reflect.get(item, '_tag') === 'string'

// A frame holds one message or a batch of them
const messagesOf = (text: string): WsMessage[] => {
  const parsed: unknown = JSON.parse(text)
  const items: readonly unknown[] = Array.isArray(parsed) ? parsed : [parsed]
  return items.filter((item) => isMessage(item))
}

export const tagOf = ({ _tag: tag }: WsMessage): string => tag

export interface WsClient {
  // One message, one frame
  readonly send: (message: object) => void
  // The next message the server sent, in order; fails with Done once the socket has closed and nothing is left
  readonly next: Effect.Effect<WsMessage, Cause.Done>
}

type Inbox = Queue.Queue<WsMessage, Cause.Done>

const listen = (socket: WebSocket, inbox: Inbox): void => {
  socket.addEventListener('message', (event) => {
    for (const message of messagesOf(String(event.data))) {
      Queue.offerUnsafe(inbox, message)
    }
  })
  socket.addEventListener('close', () => {
    Queue.endUnsafe(inbox)
  })
}

// The global WebSocket of Node and Bun, which take headers (a browser sends none but its Origin)
// The inbox listens from the start, so nothing the server sends right after the upgrade is lost
const opened = (
  url: string,
  headers: Readonly<Record<string, string>>,
  inbox: Inbox,
): Effect.Effect<WebSocket, Error> =>
  Effect.callback<WebSocket, Error>((resume) => {
    const socket = new WebSocket(url, { headers: { ...headers } })
    listen(socket, inbox)
    const failed = (): void => {
      resume(Effect.fail(new Error(`cannot open ${url}`)))
    }
    socket.addEventListener(
      'open',
      () => {
        resume(Effect.succeed(socket))
      },
      { once: true },
    )
    socket.addEventListener('error', failed, { once: true })
    return Effect.sync(() => {
      socket.close()
    })
  })

// A client of the wire protocol; the socket closes with the scope of the test, whatever its outcome
const wsClient = (
  url: string,
  headers: Readonly<Record<string, string>> = {},
): Effect.Effect<WsClient, Error, Scope.Scope> =>
  Effect.gen(function* opensClient() {
    const inbox = yield* Queue.unbounded<WsMessage, Cause.Done>()
    const socket = yield* Effect.acquireRelease(opened(url, headers, inbox), (open) =>
      Effect.sync(() => {
        open.close()
      }),
    )
    return {
      send: (message) => {
        socket.send(JSON.stringify(message))
      },
      next: Queue.take(inbox),
    }
  })

// A client of the RPC socket of the server under test; a browser would send its Origin among the headers
export const connected = (
  headers: Readonly<Record<string, string>> = {},
): Effect.Effect<WsClient, Error, HttpServer.HttpServer | Scope.Scope> =>
  baseUrl.pipe(
    Effect.flatMap((base) => wsClient(`${base.replace(/^http/u, 'ws')}${WS_PATH}`, headers)),
  )

// Reads until a message satisfies the predicate and gives every message read, that one last
// An ack follows each chunk when the stream is named, so the stream keeps coming
export const readUntil = (
  client: WsClient,
  done: (message: WsMessage) => boolean,
  ackOf?: string,
): Effect.Effect<WsMessage[], Cause.Done> =>
  Effect.gen(function* reads() {
    const read: WsMessage[] = []
    let finished = false
    while (!finished) {
      const message = yield* client.next
      read.push(message)
      if (ackOf !== undefined && tagOf(message) === 'Chunk') {
        client.send({ _tag: 'Ack', requestId: ackOf })
      }
      finished = done(message)
    }
    return read
  })

// The events a chunk carries, read through the protocol's schema as a client reads them
export const envelopesOf = (message: WsMessage | undefined): readonly EventEnvelope[] =>
  message === undefined || tagOf(message) !== 'Chunk'
    ? []
    : Schema.decodeUnknownSync(Schema.Array(EventEnvelope))(message['values'])

export interface RequestEnvelope {
  readonly id: string
  readonly tag: string
  readonly payload: unknown
  // Sent as the authorization header of the request; without one the request carries no header
  readonly token?: string | undefined
}

export const request = ({ id, tag, payload, token }: RequestEnvelope): object => ({
  _tag: 'Request',
  id,
  tag,
  payload,
  headers: token === undefined ? [] : [['authorization', `Bearer ${token}`]],
})

// Sends the request and gives the next message, which for a procedure alone on its socket is its exit
export const called = (
  client: WsClient,
  envelope: RequestEnvelope,
): Effect.Effect<WsMessage, Cause.Done> =>
  Effect.suspend(() => {
    client.send(request(envelope))
    return client.next
  })

// What the exit of a procedure that went through, or that the kernel refused with a problem of the code, holds
export const SUCCEEDED = { exit: { _tag: 'Success' } }

export const refusedWith = (code: string): object => ({
  exit: { _tag: 'Failure', cause: [{ _tag: 'Fail', error: { code } }] },
})
