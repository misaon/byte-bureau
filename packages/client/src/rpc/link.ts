import { ApiError } from '../errors.js'
import {
  decodeFrame,
  encodeInterrupt,
  encodeRequest,
  reasonOf,
  type ChunkMessage,
  type ExitMessage,
  type ServerMessage,
} from './codec.js'

// A request that ends without its exit: the connection closed under it (error), or its caller stopped it (none)
export interface Stop {
  readonly _tag: 'Stop'
  readonly error: Error | undefined
}

export type RequestMessage = ChunkMessage | ExitMessage | Stop

// The messages of one request in the order they came: the link pushes, the request takes them one at a time
export interface Inbox extends AsyncIterable<RequestMessage> {
  readonly push: (message: RequestMessage) => void
  readonly take: () => Promise<RequestMessage>
}

const inboxOf = (): Inbox => {
  const messages: RequestMessage[] = []
  const takers: ((message: RequestMessage) => void)[] = []
  const take = async (): Promise<RequestMessage> => {
    const first = messages.shift()
    if (first !== undefined) {
      return first
    }
    const { promise, resolve } = Promise.withResolvers<RequestMessage>()
    takers.push(resolve)
    const taken = await promise
    return taken
  }
  return {
    push: (message) => {
      const taker = takers.shift()
      if (taker === undefined) {
        messages.push(message)
      } else {
        taker(message)
      }
    },
    take,
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const value = await take()
        return { done: false, value }
      },
    }),
  }
}

export interface Exchange {
  readonly id: string
  readonly inbox: Inbox
  // Done with the request: it is forgotten, and interrupted unless the daemon has ended it already
  readonly release: () => void
}

/** The socket as the requests of one connection see it: each request has an inbox its messages are routed to. */
export class Link {
  public readonly url: string
  private readonly socket: WebSocket
  private readonly token: string
  // The requests the daemon has not ended yet, by id
  private readonly requests = new Map<string, Inbox>()
  private closedWith: Error | undefined
  private lastId = 0

  /**
   * @param socket The socket of the connection, listened to from now on.
   * @param url The url of the socket, which the errors name.
   * @param token The bearer token every request carries in its headers.
   */
  public constructor(socket: WebSocket, url: string, token: string) {
    this.socket = socket
    this.url = url
    this.token = token
    socket.addEventListener('message', (event) => {
      this.receive(event.data)
    })
    socket.addEventListener('close', () => {
      this.end(new ApiError(0, undefined, url))
    })
  }

  /** Sends one envelope while the connection is open. */
  public send(text: string): void {
    if (this.closedWith === undefined) {
      this.socket.send(text)
    }
  }

  /** Sends a request and gives the exchange whose inbox its messages arrive in. */
  public open(tag: string, payload: unknown): Exchange {
    this.lastId += 1
    const id = String(this.lastId)
    const inbox = inboxOf()
    if (this.closedWith === undefined) {
      this.requests.set(id, inbox)
      this.send(encodeRequest({ id, tag, payload, token: this.token }))
    } else {
      inbox.push({ _tag: 'Stop', error: this.closedWith })
    }
    return {
      id,
      inbox,
      release: () => {
        this.release(id)
      },
    }
  }

  /** Closes the socket; a request still open fails with the error given. */
  public close(error: Error): void {
    this.end(error)
    this.socket.close()
  }

  private release(id: string): void {
    if (this.requests.delete(id)) {
      this.send(encodeInterrupt(id))
    }
  }

  private receive(data: unknown): void {
    for (const message of decodeFrame(typeof data === 'string' ? data : '')) {
      this.route(message)
    }
  }

  // A defect is a failure of the whole connection; a pong needs nothing
  private route(message: ServerMessage): void {
    if ('defect' in message) {
      this.close(new Error(`the daemon failed: ${reasonOf(message.defect)}`))
    } else if ('requestId' in message) {
      this.deliver(String(message.requestId), message)
    }
  }

  // An exit is the last message of its request
  private deliver(id: string, message: ChunkMessage | ExitMessage): void {
    const inbox = this.requests.get(id)
    if ('exit' in message) {
      this.requests.delete(id)
    }
    if (inbox !== undefined) {
      inbox.push(message)
    }
  }

  private end(error: Error): void {
    this.closedWith ??= error
    for (const inbox of this.requests.values()) {
      inbox.push({ _tag: 'Stop', error: this.closedWith })
    }
    this.requests.clear()
  }
}
