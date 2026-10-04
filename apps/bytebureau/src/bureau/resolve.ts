import { readFileSync } from 'node:fs'
import { serverUrl } from '@bytebureau/protocol'
import { readServerInfo } from '../daemon/server-info.js'
import { tokenPath } from '../daemon/token.js'

// A daemon named on the command line, and the file of its token
export interface ServerFlags {
  readonly host?: string | undefined
  readonly port?: number | undefined
  readonly tokenFile?: string | undefined
}

// The Bureau a command talks to: the daemon unless --no-daemon
export interface BureauFlags extends ServerFlags {
  readonly daemon: boolean
}

type ResolvedServer =
  // A daemon named on the command line: used as it is, never started
  | { readonly kind: 'explicit'; readonly url: string; readonly token: string }
  // The live daemon of the home
  | { readonly kind: 'known'; readonly url: string; readonly token: string }
  | { readonly kind: 'none' }

// The token the home keeps in daemon.token, read as it is: tokenFor would make one for a home that has none
const keptToken = (home: string): string => {
  try {
    return readFileSync(tokenPath(home), 'utf8').trim()
  } catch {
    return ''
  }
}

const tokenOf = (flags: ServerFlags, home: string): string => {
  if (flags.tokenFile !== undefined) {
    return readFileSync(flags.tokenFile, 'utf8').trim()
  }
  const record = readServerInfo(home)
  return record.state === 'alive' ? record.info.token : keptToken(home)
}

// The daemon --host and --port name, else the live one of the home; none means one may be started
export const resolveServer = (flags: ServerFlags, home: string): ResolvedServer => {
  if (flags.host !== undefined || flags.port !== undefined) {
    const host = flags.host ?? '127.0.0.1'
    const port = flags.port ?? 4747
    return { kind: 'explicit', url: serverUrl({ host, port }), token: tokenOf(flags, home) }
  }
  const record = readServerInfo(home)
  return record.state === 'alive'
    ? { kind: 'known', url: serverUrl(record.info), token: record.info.token }
    : { kind: 'none' }
}
