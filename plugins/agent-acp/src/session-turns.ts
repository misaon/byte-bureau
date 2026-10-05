import type { PromptResponse, SessionNotification } from '@agentclientprotocol/sdk'
import type { AgentEvent, Usage } from '@bytebureau/protocol'
import { settled, type Running } from './connection.js'
import { mapUpdate } from './mapping.js'

// What a turn has gathered: the text the agent said and the last usage it reported; an interrupt, from the moment of the prompt
export interface Turn {
  text: string
  usage: Usage | undefined
  interrupted: boolean
}

export const MAX_RESTARTS = 3
const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 }

export const newTurn = (): Turn => ({ text: '', usage: undefined, interrupted: false })

const note = (turn: Turn, event: AgentEvent): void => {
  if (event.type === 'message.delta' && event.kind === 'text') {
    turn.text += event.text
  } else if (event.type === 'usage.updated') {
    turn.usage = event.usage
  }
}

// The events of an update; the turn that runs keeps the text and the usage among them
export const toldOf = (
  notification: SessionNotification,
  turn: Turn | undefined,
): readonly AgentEvent[] => {
  const events = mapUpdate(notification.update)
  if (turn !== undefined) {
    for (const event of events) {
      note(turn, event)
    }
  }
  return events
}

// A cancel to an agent that has gone is moot
export const cancelTurn = async ({ connection, sessionId }: Running): Promise<void> => {
  if (!connection.signal.aborted) {
    try {
      await connection.agent.notify('session/cancel', { sessionId })
    } catch {
      // The agent went while it was told
    }
  }
}

// The answer of the agent to a prompt, once the updates it sent before it are told
// A turn interrupted before its prompt went out is cancelled right after it
export const promptOf = async (
  running: Running,
  turn: Turn,
  text: string,
): Promise<PromptResponse> => {
  const answer = running.connection.agent.request('session/prompt', {
    sessionId: running.sessionId,
    prompt: [{ type: 'text', text }],
  })
  if (turn.interrupted) {
    await cancelTurn(running)
  }
  const response = await answer
  await settled()
  return response
}

// Whether the process of an agent has ended, which its watch may not have told yet
export const hasExited = ({ process: { child } }: Running): boolean =>
  child.exitCode !== null || child.signalCode !== null

// What the agent said in the turn, told once
const saidIn = (turn: Turn): readonly AgentEvent[] =>
  turn.text === ''
    ? []
    : [{ type: 'message.completed', role: 'assistant', content: [], text: turn.text }]

// The end of a turn the agent answered: what it said, then the turn with its stop reason and usage
export const completionOf = (turn: Turn, { stopReason }: PromptResponse): readonly AgentEvent[] => [
  ...saidIn(turn),
  {
    type: 'turn.completed',
    stopReason: stopReason === 'cancelled' ? 'interrupted' : stopReason,
    usage: turn.usage ?? NO_USAGE,
  },
]

// A prompt the agent answered with an error ends its turn on that error; the session goes on
export const refusalOf = (turn: Turn, reason: string): readonly AgentEvent[] => [
  ...saidIn(turn),
  { type: 'session.warning', kind: 'turn_error', message: reason },
  { type: 'turn.completed', stopReason: 'error', usage: turn.usage ?? NO_USAGE },
]

export const restartOf = (restart: number): AgentEvent => ({
  type: 'session.warning',
  kind: 'restart',
  message: `the agent exited idle; starting it again (${restart} of ${MAX_RESTARTS})`,
})

// A resume the agent could not load leaves the session without its history
export const notLoadedOf = (ref: string, why: string): AgentEvent => ({
  type: 'session.warning',
  kind: 'resume',
  message: `the agent could not load session ${ref} (${why}); a new session was started`,
})

// Why a session ends with its agent: mid-turn the way it died, idle that it died once too often
export const crashMessageOf = (ending: string, midTurn: boolean): string =>
  midTurn ? ending : `${ending}; it exited idle ${MAX_RESTARTS + 1} times and is not started again`

// The end of a session whose agent died: a crash in the middle of a turn may be retried, a fourth idle one may not
export const crashOf = (message: string, midTurn: boolean): readonly AgentEvent[] => [
  { type: 'session.error', kind: 'crash', message, retryable: midTurn },
  { type: 'session.closed' },
]
