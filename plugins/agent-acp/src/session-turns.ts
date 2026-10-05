import type { PromptResponse, SessionNotification } from '@agentclientprotocol/sdk'
import type { AgentEvent, Usage } from '@bytebureau/protocol'
import { settled, type Running } from './connection.js'
import { mapUpdate } from './mapping.js'

// What a running turn has gathered: the text the agent said and the last usage it reported
export interface Turn {
  text: string
  usage: Usage | undefined
}

export const MAX_RESTARTS = 3
const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 }

export const newTurn = (): Turn => ({ text: '', usage: undefined })

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

// The answer of the agent to a prompt, once the updates it sent before it are told
export const promptOf = async (
  { connection, sessionId }: Running,
  text: string,
): Promise<PromptResponse> => {
  const response = await connection.agent.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text }],
  })
  await settled()
  return response
}

// Whether the process of an agent has ended, which its watch may not have told yet
export const hasExited = ({ process: { child } }: Running): boolean =>
  child.exitCode !== null || child.signalCode !== null

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

// Why a session ends with its agent: mid-turn the way it died, idle that it died once too often
export const crashMessageOf = (ending: string, midTurn: boolean): string =>
  midTurn ? ending : `${ending}; it exited idle ${MAX_RESTARTS + 1} times and is not started again`

// The end of a session whose agent died: a crash in the middle of a turn may be retried, a fourth idle one may not
export const crashOf = (message: string, midTurn: boolean): readonly AgentEvent[] => [
  { type: 'session.error', kind: 'crash', message, retryable: midTurn },
  { type: 'session.closed' },
]
