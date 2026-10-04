import { m } from '@bytebureau/i18n'
import { serverUrl, type ServerInfo } from '@bytebureau/protocol'
import type { Context } from '../context.js'
import { isLoopback } from './hosts.js'

// The daemon as --json describes it, where it listens, its pid and its version but never its token; the url for the text
const emitted = (info: ServerInfo, context: Context): string => {
  const url = serverUrl(info)
  context.output.emit({ command: 'serve', url, pid: info.pid, version: info.version })
  return url
}

// Where the daemon listens; one the network can reach is announced with the warning of spec §11.1, naming the address it is bound to
// That address is the recorded host unless the daemon is bound to every interface, which clients reach through the loopback
export const announce = (info: ServerInfo, context: Context, bound: string = info.host): void => {
  context.output.print(m.serve_started({ url: emitted(info, context) }))
  if (!isLoopback(bound)) {
    context.output.warn(m.serve_lan_warning({ host: bound }))
  }
}

// A daemon already serving the home is what was asked for
export const alreadyRunning = (info: ServerInfo, context: Context): void => {
  context.output.print(m.serve_already_running({ url: emitted(info, context), pid: info.pid }))
}
