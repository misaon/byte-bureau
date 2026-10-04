import { once } from 'node:events'
import { createServer } from 'node:http'
import type { ServerInfo } from '@bytebureau/protocol'
import { onTestFinished } from 'vitest'

const STARTED_AT = '2026-10-04T10:00:00.000Z'

// A stand-in for the health of a daemon on a free loopback port, closed when the test ends; it answers with the start time it is given
export async function healthStub(startedAt: string = STARTED_AT): Promise<number> {
  const server = createServer((request, response) => {
    const found = request.url === '/api/v1/health'
    response.writeHead(found ? 200 : 404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok', startedAt }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  onTestFinished(() => {
    server.close()
  })
  const address = server.address()
  return typeof address === 'object' && address !== null ? address.port : 0
}

export interface ProjectsStub {
  readonly port: number
  // The authorization header of every request, in order
  readonly authorizations: () => readonly (string | undefined)[]
}

// A daemon of this test on a free loopback port that knows no projects; it keeps the token of every request
export async function projectsStub(): Promise<ProjectsStub> {
  const seen: (string | undefined)[] = []
  const server = createServer((request, response) => {
    seen.push(request.headers.authorization)
    const found = request.url === '/api/v1/projects'
    response.writeHead(found ? 200 : 404, { 'content-type': 'application/json' })
    response.end('[]')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  onTestFinished(() => {
    server.close()
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { port, authorizations: () => seen }
}

// The record of a daemon of this test on the port, as server.json holds it
export const recordOn = (port: number, pid: number = process.pid): ServerInfo => ({
  version: '0.0.0-test',
  host: '127.0.0.1',
  port,
  pid,
  token: 'a'.repeat(64),
  startedAt: STARTED_AT,
})
