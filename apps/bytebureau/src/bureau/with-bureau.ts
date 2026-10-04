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

type Env = Readonly<Record<string, string | undefined>>

// The daemon the flags name, else the live one of the home, else one started on demand
const openRemote = async (flags: ServerFlags, env: Env): Promise<Bureau> => {
  const home = kernelHome(env)
  const resolved = resolveServer(flags, home)
  if (resolved.kind !== 'none') {
    return remoteBureau(
      createBureauClient({ baseUrl: resolved.url, token: resolved.token }),
      resolved.url,
    )
  }
  const info = await ensureDaemon(home, env)
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
    const bureau = flags.daemon ? await openRemote(flags, context.env) : await openLocal(context)
    return bureau
  }
  const result = await withResource(open, work)
  return result
}
