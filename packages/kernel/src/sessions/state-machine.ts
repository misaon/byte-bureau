import type { SessionStatus } from '@bytebureau/protocol'

export const SESSION_EVENTS = [
  'provision',
  'provisioned',
  'prompt',
  'ask',
  'answer',
  'turn_done',
  'rate_limit',
  'limit_reset',
  'stop',
  'crash',
  'complete',
  'resume',
] as const
export type SessionEvent = (typeof SESSION_EVENTS)[number]

const EDGES: Readonly<
  Record<SessionEvent, Partial<Readonly<Record<SessionStatus, SessionStatus>>>>
> = {
  provision: { created: 'provisioning' },
  provisioned: { provisioning: 'ready' },
  prompt: { ready: 'running' },
  ask: { running: 'waiting_for_human' },
  answer: { waiting_for_human: 'running' },
  // A turn that ends while the session waits for a usage limit leaves it ready too
  turn_done: { running: 'ready', waiting_for_human: 'ready', paused_usage_limit: 'ready' },
  rate_limit: { running: 'paused_usage_limit' },
  limit_reset: { paused_usage_limit: 'running' },
  stop: {
    created: 'stopped',
    ready: 'stopped',
    running: 'stopped',
    waiting_for_human: 'stopped',
    paused_usage_limit: 'stopped',
    provisioning: 'stopped',
  },
  // A session can die before it is provisioned, and be ended then
  crash: {
    created: 'errored',
    running: 'errored',
    waiting_for_human: 'errored',
    provisioning: 'errored',
  },
  complete: { ready: 'completed' },
  resume: { stopped: 'ready', errored: 'ready' },
}

// A null result means "not allowed from this status"; callers turn it into SessionError('invalid_transition')
export const transition = (status: SessionStatus, event: SessionEvent): SessionStatus | null =>
  EDGES[event][status] ?? null
