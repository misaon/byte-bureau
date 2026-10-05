import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { onTestFinished } from 'vitest'

// One SSE frame as the daemon writes it: durable events carry their seq as the id, ephemeral ones (seq 0) none
export const frame = (seq: number, type: string): string => {
  const envelope = { seq, id: `e${seq}`, ts: '2026-10-04T00:00:00.000Z', type, payload: {} }
  const id = seq === 0 ? '' : `id: ${seq}\n`
  return `${id}event: ${type}\ndata: ${JSON.stringify(envelope)}\n\n`
}

interface Seen {
  readonly method: string
  // The request target as it came over the wire, percent-encoding intact; url is the same decoded
  readonly target: string
  readonly url: string
  readonly body: string
  readonly lastEventId: string | undefined
  readonly authorization: string | undefined
}

export interface Served {
  readonly url: string
  readonly requests: readonly Seen[]
}

// What the fake daemon does with the connection of its turn
export type Step = (response: ServerResponse) => void

const headerOf = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

const seenOf = (request: IncomingMessage, body: string): Seen => ({
  method: request.method ?? '',
  target: request.url ?? '',
  url: decodeURIComponent(request.url ?? ''),
  body,
  lastEventId: headerOf(request, 'last-event-id'),
  authorization: headerOf(request, 'authorization'),
})

const portOf = (address: ReturnType<ReturnType<typeof createServer>['address']>): number => {
  if (address === null || typeof address === 'string') {
    throw new Error('the fake daemon has no port')
  }
  return address.port
}

// A fake daemon on a loopback port: each connection gets the step of its turn, the last step repeats; it closes with the test
export const serve = async (script: readonly Step[]): Promise<Served> => {
  const requests: Seen[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    request.on('end', () => {
      requests.push(seenOf(request, Buffer.concat(chunks).toString('utf8')))
      const step = script[Math.min(requests.length, script.length) - 1]
      if (step !== undefined) {
        step(response)
      }
    })
  })
  const listening = Promise.withResolvers<boolean>()
  server.listen(0, '127.0.0.1', () => {
    listening.resolve(true)
  })
  await listening.promise
  onTestFinished(async () => {
    const closed = Promise.withResolvers<boolean>()
    server.closeAllConnections()
    server.close(() => {
      closed.resolve(true)
    })
    await closed.promise
  })
  return { url: `http://127.0.0.1:${portOf(server.address())}`, requests }
}

// An event stream: the frames given, then the end of the response unless it is kept open
export const stream =
  (body: string, end = true): Step =>
  (response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(body)
    if (end) {
      response.end()
    }
  }

// An answer with a status and, when given, a problem as its body
export const status =
  (code: number, problem?: object): Step =>
  (response) => {
    if (problem === undefined) {
      response.writeHead(code).end()
      return
    }
    response.writeHead(code, { 'content-type': 'application/problem+json' })
    response.end(JSON.stringify(problem))
  }

// An answer with a status and a JSON body
export const json =
  (code: number, body: object): Step =>
  (response) => {
    response.writeHead(code, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }

// A connection that breaks before any answer
export const broken: Step = (response) => {
  response.destroy()
}

// A page that is no event stream, as a proxy in the way would answer
export const page: Step = (response) => {
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end('<html><body>sign in to the proxy</body></html>')
}
