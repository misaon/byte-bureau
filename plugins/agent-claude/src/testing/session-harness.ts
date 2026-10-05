import type { AgentEvent, CreateSessionRequest } from '@bytebureau/plugin-api'
import { ClaudeSession } from '../session.js'
import { fakeQuery, type FakeQuery, type FakeScript } from './fake-query.js'
import { recordingLogger, sessionRequest, type LogEntry } from './requests.js'

export interface Started {
  readonly session: ClaudeSession
  readonly fake: FakeQuery
  readonly logged: LogEntry[]
}

// A session over a fake query that plays the script, with a logger that keeps what it is told
export const start = (
  script: FakeScript,
  request: CreateSessionRequest = sessionRequest(),
): Started => {
  const fake = fakeQuery(script)
  const { logger, entries } = recordingLogger()
  return {
    session: new ClaudeSession({ query: fake.query, logger }, request, undefined),
    fake,
    logged: entries,
  }
}

// The events of a session up to the first of the type, that one included
export const until = async (
  session: ClaudeSession,
  type: AgentEvent['type'],
): Promise<AgentEvent[]> => {
  const seen: AgentEvent[] = []
  for await (const event of session.events()) {
    seen.push(event)
    if (event.type === type) {
      break
    }
  }
  return seen
}

// Every event a session still has to tell, up to its end
export const rest = async (session: ClaudeSession): Promise<AgentEvent[]> => {
  const seen: AgentEvent[] = []
  for await (const event of session.events()) {
    seen.push(event)
  }
  return seen
}
