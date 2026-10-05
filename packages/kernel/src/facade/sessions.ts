import { Effect } from 'effect'
import { AskService } from '../asks/ask-service.js'
import { ProfileService } from '../profiles/profile-service.js'
import { SessionManager } from '../sessions/session-manager.js'
import { profileUsage } from '../usage/profile-usage.js'
import { UsageService } from '../usage/usage-service.js'
import type { Captured, Promised } from './promised.js'
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

// The usage of a profile as the API tells it: it reads the profiles and the snapshots, from the captured services
export const usageApi = (promised: Promised, services: Captured): Kernel['usage'] => ({
  session: promised(UsageService, (usage, sessionId) => usage.sessionUsage(sessionId)),
  profile: promised(ProfileService, (_profiles, id: string) =>
    Effect.provide(profileUsage(id), services),
  ),
})
