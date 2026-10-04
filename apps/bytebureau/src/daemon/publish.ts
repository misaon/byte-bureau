import type { RunningDaemon } from '@bytebureau/api/bun'
import type { ServerInfo } from '@bytebureau/protocol'
import type { Context } from '../context.js'
import { version } from '../version.js'
import { announce } from './announce.js'
import { clientHost } from './hosts.js'
import { writeServerInfo } from './server-info.js'

export interface Published {
  readonly daemon: RunningDaemon
  readonly token: string
}

// What server.json says of the daemon of this process: the host clients use, which for a wildcard bind is the loopback
// The wildcard itself is kept as well, so the command that started the daemon can warn of it as the daemon does
const recordOf = ({ daemon, token }: Published): ServerInfo => {
  const bound = daemon.address.host
  const host = clientHost(bound)
  return {
    version,
    host,
    port: daemon.address.port,
    pid: process.pid,
    token,
    startedAt: daemon.startedAt,
    ...(bound === host ? {} : { bind: bound }),
  }
}

// From here on clients find the daemon; the warning for a daemon the network can reach names the address it is bound to
export const publish = (home: string, published: Published, context: Context): void => {
  const info = recordOf(published)
  writeServerInfo(home, info)
  announce(info, context)
}
