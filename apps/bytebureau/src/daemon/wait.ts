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
