import { utimesSync, writeFileSync } from 'node:fs'
import { processStartedAt } from '../daemon/process-start.js'
import { lockPath } from '../daemon/server-info.js'

const AN_HOUR = 3_600_000

/**
 * A lock left from before a crash or a reboot, naming a process that got the pid since: written an hour before that
 * process started, or an hour ago where the platform cannot tell when it did.
 */
export async function oldLock(home: string, pid: number): Promise<void> {
  writeFileSync(lockPath(home), String(pid))
  const started = await processStartedAt(pid)
  const written = new Date((started ?? Date.now()) - AN_HOUR)
  utimesSync(lockPath(home), written, written)
}

// When a process started, for a judgement on a platform that cannot tell
export const unknownStart = async (): Promise<number | undefined> => {
  await Promise.resolve()
  return undefined
}
