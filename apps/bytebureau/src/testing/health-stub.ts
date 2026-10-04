import { createServer } from 'node:http'
import type { ServerInfo } from '@bytebureau/protocol'
import { onTestFinished } from 'vitest'
import { listening } from './listening.js'

const STARTED_AT = '2026-10-04T10:00:00.000Z'

// A stand-in for the health of a daemon on a free loopback port, closed when the test ends; it answers with the start time it is given
export async function healthStub(startedAt: string = STARTED_AT): Promise<number> {
  const server = createServer((request, response) => {
    const found = request.url === '/api/v1/health'
    response.writeHead(found ? 200 : 404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok', startedAt }))
  })
  const { port, close } = await listening(server)
  onTestFinished(close)
  return port
}

export interface ProjectsStub {
  readonly port: number
  // The authorization header of every request for the projects, in order
  readonly authorizations: () => readonly (string | undefined)[]
}

// A daemon of this test on a free loopback port that knows no projects; it keeps the token of every request for them
// Its health answers with the start time of recordOn, as the daemon of such a record does
export async function projectsStub(): Promise<ProjectsStub> {
  const seen: (string | undefined)[] = []
  const server = createServer((request, response) => {
    const health = request.url === '/api/v1/health'
    if (!health) {
      seen.push(request.headers.authorization)
    }
    const found = health || request.url === '/api/v1/projects'
    response.writeHead(found ? 200 : 404, { 'content-type': 'application/json' })
    response.end(health ? JSON.stringify({ status: 'ok', startedAt: STARTED_AT }) : '[]')
  })
  const { port, close } = await listening(server)
  onTestFinished(close)
  return { port, authorizations: () => seen }
}

// A daemon of this test on a free loopback port that refuses every request with a problem of the status, the code and the detail
export async function refusingStub(status: number, code: string, detail: string): Promise<number> {
  const server = createServer((_request, response) => {
    const type = `https://bytebureau.dev/problems/${code}`
    response.writeHead(status, { 'content-type': 'application/problem+json' })
    response.end(JSON.stringify({ type, title: 'Refused', status, detail, code }))
  })
  const { port, close } = await listening(server)
  onTestFinished(close)
  return port
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
