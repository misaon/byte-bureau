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
const recordOf = ({ daemon, token }: Published): ServerInfo => ({
  version,
  host: clientHost(daemon.address.host),
  port: daemon.address.port,
  pid: process.pid,
  token,
  startedAt: daemon.startedAt,
})

// From here on clients find the daemon; the warning for a daemon the network can reach names the address it is bound to
export const publish = (home: string, published: Published, context: Context): void => {
  const info = recordOf(published)
  writeServerInfo(home, info)
  announce(info, context, published.daemon.address.host)
}
