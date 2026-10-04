import type { ServerInfo } from '@bytebureau/protocol'
import { startDetached } from '../daemon/start.js'
import { runningDaemon } from '../daemon/wait.js'
import { daemonEnv } from './session-env.js'

class DaemonUnavailableError extends Error {
  public override readonly name = 'DaemonUnavailableError'
}

// The daemon of the home, started detached as serve starts it when none answers; a start that fails says why, naming the log or the lock
// Only a daemon whose health answers with the start time of server.json counts, never a process that took over its pid
// It gets the environment of the command without the choices of that run, which would be its defaults for every later one
export const ensureDaemon = async (
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ServerInfo> => {
  const running = await runningDaemon(home)
  if (running !== undefined) {
    return running
  }
  const started = await startDetached(home, daemonEnv(env), [])
  if (!started.up) {
    throw new DaemonUnavailableError(started.reason)
  }
  return started.info
}
