import { Effect } from 'effect'
import { AskService } from '../asks/ask-service.js'
import { missingProfile } from '../profiles/profile-records.js'
import { ProfileService } from '../profiles/profile-service.js'
import { SessionManager } from '../sessions/session-manager.js'
import { UsageService } from '../usage/usage-service.js'
import type { Promised } from './promised.js'
import type { Kernel } from './types.js'

export const sessionsApi = (promised: Promised): Kernel['sessions'] => ({
  create: promised(SessionManager, (sessions, input) => sessions.create(input)),
  prompt: promised(SessionManager, (sessions, sessionId, input) =>
    sessions.prompt(sessionId, input),
  ),
  interrupt: promised(SessionManager, (sessions, sessionId) => sessions.interrupt(sessionId)),
  stop: promised(SessionManager, (sessions, sessionId) => sessions.stop(sessionId)),
  complete: promised(SessionManager, (sessions, sessionId) => sessions.complete(sessionId)),
  resume: promised(SessionManager, (sessions, sessionId) => sessions.resume(sessionId)),
  list: promised(SessionManager, (sessions) => sessions.list()),
  get: promised(SessionManager, (sessions, id) => sessions.get(id)),
  recover: promised(SessionManager, (sessions) => sessions.recover()),
})

export const asksApi = (promised: Promised): Kernel['asks'] => ({
  pending: promised(AskService, (asks, sessionId) => asks.pending(sessionId)),
  get: promised(AskService, (asks, id) => asks.get(id)),
  // The record of the settled ask is not handed on
  answer: promised(AskService, (asks, ...args) => Effect.asVoid(asks.answer(...args))),
})

// A profile nobody holds is not found; one no rate limit was seen under has an empty snapshot, as the API tells them
export const usageApi = (promised: Promised): Kernel['usage'] => {
  const profileOf = promised(ProfileService, (profiles, id: string) => profiles.get(id))
  const snapshotOf = promised(UsageService, (usage, id: string) => usage.snapshot(id))
  return {
    session: promised(UsageService, (usage, sessionId) => usage.sessionUsage(sessionId)),
    profile: async (id) => {
      if ((await profileOf(id)) === undefined) {
        throw missingProfile(id)
      }
      const snapshot = await snapshotOf(id)
      return snapshot ?? { profileId: id, rateLimit: {}, observedAt: null }
    },
  }
}
