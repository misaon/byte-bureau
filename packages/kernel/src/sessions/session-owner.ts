import type { SessionStatus } from '@bytebureau/protocol'
import { isAlive } from '../process/pid-alive.js'
import type { SessionDeps } from './session-deps.js'
import type { OwnedSession, SessionOwner } from './session-records.js'

// The statuses a kernel works in; a session can be stopped from each of them
export const RECOVERABLE: readonly SessionStatus[] = [
  'created',
  'provisioning',
  'running',
  'waiting_for_human',
  'paused_usage_limit',
]

// A kernel of another process owns a session while that process runs; an earlier kernel of this process, or one that is gone, owns nothing any more
const isOwnerGone = (owner: SessionOwner, { instance }: Pick<SessionDeps, 'instance'>): boolean => {
  if (owner.pid === null) {
    return true
  }
  return owner.pid === instance.pid ? owner.instance !== instance.id : !isAlive(owner.pid)
}

// Left behind: in a status of work, attached nowhere in this process, and owned by no kernel that still runs
export const isLeftBehind = (
  deps: Pick<SessionDeps, 'live' | 'instance'>,
  { session, owner }: OwnedSession,
): boolean =>
  RECOVERABLE.includes(session.status) &&
  deps.live.get(session.id) === undefined &&
  isOwnerGone(owner, deps)
