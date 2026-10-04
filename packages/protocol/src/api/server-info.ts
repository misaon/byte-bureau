import { Schema } from 'effect'
import { Timestamp } from '../common.js'

// The record of <home>/server.json: where the daemon listens and how to talk to it; the token is a secret
// Host is the address clients use; bind, when there is one, the address the daemon is bound to, every interface of a family
export const ServerInfo = Schema.Struct({
  version: Schema.String,
  host: Schema.String,
  port: Schema.Int,
  pid: Schema.Int,
  token: Schema.String,
  startedAt: Timestamp,
  bind: Schema.optionalKey(Schema.String),
}).annotate({ title: 'ServerInfo' })

export type ServerInfo = typeof ServerInfo.Type

export const decodeServerInfo = (input: unknown): ServerInfo =>
  Schema.decodeUnknownSync(ServerInfo)(input, { onExcessProperty: 'error' })

// An IPv6 host is bracketed in a URL
export const serverUrl = ({ host, port }: Pick<ServerInfo, 'host' | 'port'>): string =>
  `http://${host.includes(':') ? `[${host}]` : host}:${port}`
