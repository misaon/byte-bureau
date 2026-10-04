import type {
  AgentCapabilities,
  AgentProvider,
  AgentSession,
  AuthStatus,
  CreateSessionRequest,
} from '@bytebureau/plugin-api'
import { FAKE_API_KEY_ENV, FakeSession, type Script } from './fake-agent-session.js'

const CAPABILITIES: AgentCapabilities = {
  resume: false,
  interrupt: true,
  askUser: true,
  permissions: false,
  structuredOutput: false,
  usage: true,
  rateLimits: false,
  contextUsage: true,
  thinking: false,
  setModel: false,
  setEffort: false,
  attachments: false,
}

// The session environment picks the script, else the flavour of the provider options: slow, anything else is hello
const scriptOf = (request: CreateSessionRequest): Script =>
  (request.env['BYTEBUREAU_FAKE_SCRIPT'] ?? request.providerConfig['flavour']) === 'slow'
    ? 'slow'
    : 'hello'

const loggedIn = async (): Promise<AuthStatus> => {
  const state = await Promise.resolve('loggedIn' as const)
  return { state }
}

const startSession = async (request: CreateSessionRequest): Promise<AgentSession> => {
  const session = await Promise.resolve(new FakeSession(request, scriptOf(request)))
  return session
}

// A provider that needs no agent subscription: the way to smoke-test an installation and the fixture of the tests
export class FakeAgentProvider implements AgentProvider {
  public readonly id = 'fake'
  public readonly displayName = 'Fake agent (tests and CI)'
  public readonly capabilities = CAPABILITIES
  public readonly apiKeyEnv = FAKE_API_KEY_ENV
  public readonly authStatus = loggedIn
  public readonly createSession = startSession
}
