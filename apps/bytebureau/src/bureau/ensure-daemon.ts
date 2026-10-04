import { m } from '@bytebureau/i18n'
import type { ServerInfo } from '@bytebureau/protocol'
import { daemonLogPath, spawnDaemon } from '../daemon/spawn.js'
import { runningDaemon, waitForDaemon } from '../daemon/wait.js'
import { daemonEnv } from './session-env.js'

class DaemonUnavailableError extends Error {
  public override readonly name = 'DaemonUnavailableError'
}

// The daemon of the home, started detached as serve starts it when none answers; a start that does not come up in time names the log that says why
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
  spawnDaemon(home, daemonEnv(env), [])
  const started = await waitForDaemon(home)
  if (started === undefined) {
    throw new DaemonUnavailableError(m.serve_timeout({ log: daemonLogPath(home) }))
  }
  return started
}
