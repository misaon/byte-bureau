import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { AccountInfo, Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AuthStatus, ProfileRef } from '@bytebureau/plugin-api'
import { startQuery, type AgentQuery, type ClaudeDeps } from './deps.js'
import { Queue } from './queue.js'
import { withinLimit } from './within-limit.js'

interface Probe {
  readonly deps: ClaudeDeps
  readonly profile: ProfileRef
  readonly executable: string | undefined
}

const PROBE_LIMIT_MS = 20_000
const TOO_SLOW = 'the Claude login check did not answer within 20 s'
const API_KEY_HINT = 'run a session to check an API-key profile'
// Whole words only, so a proxy's "authorization" or a book's "author" in an unrelated failure is no login error; the SDK throws no typed error for a login
const LOGGED_OUT =
  /\b(?:log(?:ged)?[ -]?in|logged[ -]out|auth|authentication(?:_failed)?|unauthorized|unauthorised|401)\b/iu
// The variables of the daemon the check passes on, the fixed ones of the kernel's allowlist; Claude Code finds a login in the macOS keychain by USER
const PASSED: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'TMPDIR',
  'TERM',
  'SSH_AUTH_SOCK',
  'TRACEPARENT',
])

// A word a shell would split or expand is quoted, so a command can be pasted as it is
const shellWord = (value: string): string =>
  /^[\w./:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", String.raw`'\''`)}'`

// The command that logs a login profile in, which the CLI prints after "Log in with:"
const loginHint = (profile: ProfileRef): string =>
  profile.configDir === undefined
    ? 'claude /login'
    : `CLAUDE_CONFIG_DIR=${shellWord(profile.configDir)} claude /login`

const envOf = (profile: ProfileRef): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && (PASSED.has(name) || name.startsWith('LC_'))) {
      env[name] = value
    }
  }
  return profile.configDir === undefined ? env : { ...env, CLAUDE_CONFIG_DIR: profile.configDir }
}

// A login has an account or the source of a credential; a CLI that has none answers without either, and throws nothing
const statusOf = (account: AccountInfo, profile: ProfileRef): AuthStatus => {
  const name = account.email ?? account.organization
  if (name !== undefined) {
    return { state: 'loggedIn', account: name }
  }
  const sources = [account.tokenSource, account.apiKeySource]
  const credential = sources.some((source) => source !== undefined && source !== 'none')
  return credential ? { state: 'loggedIn' } : { state: 'loggedOut', hint: loginHint(profile) }
}

const failedStatus = (error: unknown, profile: ProfileRef): AuthStatus => {
  const reason = error instanceof Error ? error.message : String(error)
  if (/expired/iu.test(reason)) {
    return { state: 'expired', hint: loginHint(profile) }
  }
  return LOGGED_OUT.test(reason)
    ? { state: 'loggedOut', hint: loginHint(profile) }
    : { state: 'unknown', hint: reason }
}

// A query given nothing to say, only to learn who is logged in
const startProbe = ({ deps, profile, executable }: Probe, abort: AbortController): AgentQuery => {
  const input = new Queue<SDKUserMessage>()
  input.end()
  const options: Options = {
    cwd: tmpdir(),
    env: envOf(profile),
    settingSources: [],
    permissionMode: 'default',
    maxTurns: 1,
    abortController: abort,
    ...(executable === undefined ? {} : { pathToClaudeCodeExecutable: executable }),
  }
  return startQuery(deps, { prompt: input, options })
}

const accountOf = async (probe: AgentQuery): Promise<AccountInfo> => {
  await probe.initializationResult()
  const account = await probe.accountInfo()
  return account
}

// The probe is closed whatever happens, and given 20 s, after which it is aborted
const probed = async (probe: Probe): Promise<AuthStatus> => {
  const abort = new AbortController()
  const query = startProbe(probe, abort)
  try {
    const account = await withinLimit(accountOf(query), PROBE_LIMIT_MS)
    if (account === null) {
      abort.abort()
      return { state: 'unknown', hint: TOO_SLOW }
    }
    return statusOf(account, probe.profile)
  } catch (error) {
    return failedStatus(error, probe.profile)
  } finally {
    query.close()
  }
}

// A login profile whose directory is gone needs a login; an API-key profile is checked by the session it runs, as the kernel passes no key here
export const authStatusOf = async (
  deps: ClaudeDeps,
  profile: ProfileRef,
  executable: string | undefined,
): Promise<AuthStatus> => {
  if (profile.kind === 'api_key') {
    return { state: 'unknown', hint: API_KEY_HINT }
  }
  if (profile.configDir !== undefined && !existsSync(profile.configDir)) {
    return { state: 'loggedOut', hint: loginHint(profile) }
  }
  const status = await probed({ deps, profile, executable })
  return status
}
