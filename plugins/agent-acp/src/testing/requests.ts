import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  CreateSessionRequest,
  EmployeeSpec,
  Logger,
  LogLevel,
  ProfileRef,
  ProjectTrust,
} from '@bytebureau/plugin-api'
import { onTestFinished } from 'vitest'

const SESSION_ID = '0192f0c8-7b2e-7c3d-9a4b-000000000007'

export const TRUST_HINT =
  'the project names a command the user configuration does not trust: add it to trust.commands, or the project to trust.projects, in /home/dev/.bytebureau/config.json'

// A project the user trusts: its whole section reaches the adapter
export const TRUSTED: ProjectTrust = { project: true, withheld: [], hint: TRUST_HINT }
// A key that must never be seen anywhere but in the environment of the agent
export const CANARY_KEY = 'sk-acp-canary-0000000000000000'

export interface LogEntry {
  readonly level: LogLevel
  readonly message: string
  readonly properties: Readonly<Record<string, unknown>> | undefined
}

// A logger that keeps what it is told, for the tests that look at what was logged
export function recordingLogger(): { readonly logger: Logger; readonly entries: LogEntry[] } {
  const entries: LogEntry[] = []
  const at =
    (level: LogLevel): Logger['debug'] =>
    (message, properties) => {
      entries.push({ level, message, properties })
    }
  const logger: Logger = {
    category: ['test'],
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  }
  return { logger, entries }
}

// A directory of the test's own, real path resolved (macOS keeps temporary files behind /var -> /private/var), removed when the test ends
export function tempDir(prefix: string): string {
  const created = mkdtempSync(path.join(tmpdir(), prefix))
  const dir = realpathSync(created)
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

const employee: EmployeeSpec = {
  id: 'dev',
  name: 'Dev',
  provider: 'acp:custom',
  model: 'default',
  effort: null,
  systemPrompt: 'You write TypeScript.',
  tools: { allow: [], deny: [] },
  permissionMode: 'supervised',
  skills: [],
  appearance: {},
}

const loginProfile: ProfileRef = { id: 'default', providerId: 'acp:custom', kind: 'login' }

// A request as the kernel makes it: the allowlisted environment, the profile and the provider options
export const sessionRequest = (
  overrides: Partial<CreateSessionRequest> = {},
): CreateSessionRequest => ({
  sessionId: SESSION_ID,
  workspace: { path: '/w' },
  employee,
  profile: loginProfile,
  providerConfig: {},
  trust: TRUSTED,
  env: { PATH: '/usr/bin:/bin', HOME: '/home/dev' },
  signal: new AbortController().signal,
  logger: recordingLogger().logger,
  ...overrides,
})
