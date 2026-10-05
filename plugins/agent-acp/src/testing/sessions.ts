import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type {
  AgentEvent,
  AgentSession,
  AskAnswer,
  CreateSessionRequest,
} from '@bytebureau/plugin-api'
import { AcpAgentProvider } from '../provider.js'
import type { FakeScript } from './fake-acp-agent.js'
import { sessionRequest, tempDir } from './requests.js'
import { fakeAgentCommand } from './run-fake.js'
import { harness, started, until, type Harness } from './session-harness.js'

export const TURN_END = 'turn.completed'
const ALLOW: AskAnswer = { selected: ['allow'] }

// A workspace with a parent of its own, so a file above it is the test's too
export const workspaceOf = (): string => {
  const workspace = path.join(tempDir('bb-acp-ws-'), 'ws')
  mkdirSync(workspace)
  return workspace
}

// The providers["acp:custom"] section that runs the fake agent
export const customOf = (
  script: FakeScript,
  extra: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => ({ ...fakeAgentCommand(script), ...extra })

// A session of the custom provider over the fake agent, closed when the test ends
export const sessionOf = async (
  request: Partial<CreateSessionRequest>,
  run: Harness = harness(),
): Promise<AgentSession> => {
  const provider = new AcpAgentProvider('custom', run.deps)
  const session = await started(provider, sessionRequest(request))
  return session
}

// The events of a prompt up to the first of the type, its asks allowed as they come
export const prompted = async (
  session: AgentSession,
  text: string,
  last: AgentEvent['type'] = TURN_END,
): Promise<AgentEvent[]> => {
  const reading = until(session, last, ALLOW)
  await session.prompt({ text })
  const seen = await reading
  return seen
}
