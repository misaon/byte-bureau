import type { KernelEvent, SessionStatus } from '@bytebureau/protocol'
import type { SessionEvent } from './state-machine.js'

// Why a session failed: the kinds are those of the session.error event of a provider
export interface Failure {
  readonly kind: 'auth' | 'ratelimit' | 'crash' | 'protocol'
  readonly message: string
  readonly retryable: boolean
}

// Every transition that is announced with the new status alone
// The pause for a usage limit has no driver yet, and a wait and a failure carry more than the status
export type PlainEvent = Exclude<SessionEvent, 'ask' | 'crash' | 'rate_limit' | 'limit_reset'>

type Announce = (status: SessionStatus) => KernelEvent

// The event of the catalogue that tells of each transition
const PLAIN: Readonly<Record<PlainEvent, Announce>> = {
  provision: (status) => ({ type: 'session.provisioning', payload: { status } }),
  provisioned: (status) => ({ type: 'session.ready', payload: { status } }),
  prompt: (status) => ({ type: 'session.running', payload: { status } }),
  answer: (status) => ({ type: 'session.running', payload: { status } }),
  turn_done: (status) => ({ type: 'session.ready', payload: { status } }),
  stop: (status) => ({ type: 'session.stopped', payload: { status } }),
  complete: (status) => ({ type: 'session.completed', payload: { status } }),
  resume: (status) => ({ type: 'session.resumed', payload: { status } }),
}

export const plainEvent = (event: PlainEvent, status: SessionStatus): KernelEvent =>
  PLAIN[event](status)

export const waitingEvent = (status: SessionStatus, askId: string): KernelEvent => ({
  type: 'session.waiting',
  payload: { status, askId },
})

export const erroredEvent = (status: SessionStatus, failure: Failure): KernelEvent => ({
  type: 'session.errored',
  payload: { status, kind: failure.kind, message: failure.message, retryable: failure.retryable },
})
