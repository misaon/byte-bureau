import { readFileSync } from 'node:fs'
import { m } from '@bytebureau/i18n'
import { serverUrl } from '@bytebureau/protocol'
import { readServerInfo } from '../daemon/server-info.js'
import { usageError } from '../usage-error.js'

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
  // None named: the daemon of the home is the one that answers, or one started on demand
  | { readonly kind: 'none' }

// The token a --token-file holds; a file that cannot be read is named, which the error of the system does in its own words
const tokenIn = (file: string): string => {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch (error) {
    throw new Error(m.bureau_token_file_unreadable({ file }), { cause: error })
  }
}

// The token of --token-file, else that of this home, which goes only to the daemon its record names: any other host would receive it with every request
const tokenOf = (flags: ServerFlags, home: string, url: string): string => {
  if (flags.tokenFile !== undefined) {
    return tokenIn(flags.tokenFile)
  }
  const record = readServerInfo(home)
  if (record.state === 'alive' && serverUrl(record.info) === url) {
    return record.info.token
  }
  throw usageError(
    `no daemon of this home listens on ${url}: pass the token of the daemon there with --token-file`,
  )
}

// The daemon --host and --port name; server.json names none, as only an answer of its daemon tells that a record holds
export const resolveServer = (flags: ServerFlags, home: string): ResolvedServer => {
  if (flags.host === undefined && flags.port === undefined) {
    return { kind: 'none' }
  }
  const url = serverUrl({ host: flags.host ?? '127.0.0.1', port: flags.port ?? 4747 })
  return { kind: 'explicit', url, token: tokenOf(flags, home, url) }
}
