import { createBureauClient } from '@bytebureau/client'
import { serverUrl } from '@bytebureau/protocol'
import type { Context } from '../context.js'
import { kernelHome } from '../kernel-home.js'
import { withResource } from '../resource.js'
import type { Bureau } from './bureau.js'
import { ensureDaemon } from './ensure-daemon.js'
import { openLocal } from './open-local.js'
import { remoteBureau } from './remote.js'
import { resolveServer, type BureauFlags, type ServerFlags } from './resolve.js'

// The daemon the flags name, else the daemon of the home that answers, else one started on demand
// A record whose daemon does not answer (its pid taken over after a crash, a daemon on its way out) leads to a start, never to a failure
const openRemote = async (flags: ServerFlags, context: Context): Promise<Bureau> => {
  const named = resolveServer(flags, kernelHome(context.env))
  if (named.kind === 'explicit') {
    return remoteBureau(createBureauClient({ baseUrl: named.url, token: named.token }), named.url)
  }
  const info = await ensureDaemon(context)
  const url = serverUrl(info)
  return remoteBureau(createBureauClient({ baseUrl: url, token: info.token }), url)
}

// A Bureau for the length of the work, closed after it: the daemon's unless --no-daemon
export const withBureau = async <Result>(
  context: Context,
  flags: BureauFlags,
  work: (bureau: Bureau) => Promise<Result>,
): Promise<Result> => {
  const open = async (): Promise<Bureau> => {
    const bureau = flags.daemon ? await openRemote(flags, context) : await openLocal(context)
    return bureau
  }
  const result = await withResource(open, work)
  return result
}
