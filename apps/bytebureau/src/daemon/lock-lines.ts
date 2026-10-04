import { m } from '@bytebureau/i18n'
import type { Keeper } from './lock.js'
import { lockPath } from './server-info.js'

// Why a start cannot take the lock of the home from the holder that keeps it, naming the lock and the pid
export const keptBy = (holder: Keeper, home: string, pid: number): string => {
  if (holder === 'silent') {
    return m.serve_lock_silent({ lock: lockPath(home), pid })
  }
  return holder === 'stuck'
    ? m.serve_lock_stuck({ lock: lockPath(home), pid })
    : `a daemon is already running (pid ${pid})`
}
