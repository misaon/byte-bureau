import { m } from '@bytebureau/i18n'
import { serverUrl } from '@bytebureau/protocol'
import type { Context } from '../context.js'
import { runningDaemon } from '../daemon/wait.js'
import { kernelHome } from '../kernel-home.js'
import { version } from '../version.js'
import type { Bureau } from './bureau.js'
import { localBureau } from './local.js'

export class DaemonRunningError extends Error {
  public override readonly name = 'DaemonRunningError'
}

// The store has one writer: the kernel of this process is refused while the daemon of the same home answers
// The module of the kernel needs Bun; it is imported only to open the kernel, so this one loads under Node, where its tests run
export const openLocal = async (context: Context): Promise<Bureau> => {
  const running = await runningDaemon(kernelHome(context.env))
  if (running !== undefined) {
    throw new DaemonRunningError(
      m.bureau_daemon_running({ pid: running.pid, url: serverUrl(running) }),
    )
  }
  const { openKernel } = await import('../kernel.js')
  return localBureau(await openKernel(context), version)
}
