import { setTimeout as sleep } from 'node:timers/promises'
import { serverUrl, type ServerInfo } from '@bytebureau/protocol'
import { readServerInfo } from './server-info.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

// The daemon of the record answers its health with the start time the record names; a process that took over its pid or its port does not
export const daemonAnswers = async (info: ServerInfo): Promise<boolean> => {
  try {
    const response = await fetch(`${serverUrl(info)}/api/v1/health`, {
      signal: AbortSignal.timeout(1000),
    })
    const text = await response.text()
    const body: unknown = response.ok ? JSON.parse(text) : undefined
    return isRecord(body) && body['startedAt'] === info.startedAt
  } catch {
    return false
  }
}

// The daemon that serves the home now: server.json names a live pid and the daemon answers
export const runningDaemon = async (home: string): Promise<ServerInfo | undefined> => {
  const record = readServerInfo(home)
  return record.state === 'alive' && (await daemonAnswers(record.info)) ? record.info : undefined
}

const poll = async (home: string, deadline: number): Promise<ServerInfo | undefined> => {
  const running = await runningDaemon(home)
  if (running !== undefined || Date.now() >= deadline) {
    return running
  }
  await sleep(100)
  return poll(home, deadline)
}

// The daemon is up once server.json names it and it answers; a daemon that takes longer than the limit is given up on
export const waitForDaemon = async (
  home: string,
  timeoutMs = 10_000,
): Promise<ServerInfo | undefined> => {
  const running = await poll(home, Date.now() + timeoutMs)
  return running
}
