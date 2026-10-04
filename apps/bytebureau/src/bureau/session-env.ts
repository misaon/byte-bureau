type Env = Readonly<Record<string, string | undefined>>

const OURS = 'BYTEBUREAU_'

// The BYTEBUREAU_* names that are a daemon's own: where it keeps its data, how much it logs, the runtime of its worktrees
const DAEMON_OWN: ReadonlySet<string> = new Set([
  'BYTEBUREAU_HOME',
  'BYTEBUREAU_LOG_LEVEL',
  'BYTEBUREAU_WORKSPACE_RUNTIME',
])

// What the environment of the command chooses for a session where the flags choose nothing
export interface SessionChoices {
  readonly employee: string | undefined
  readonly branch: string | undefined
  // The BYTEBUREAU_* variables, which the agent gets; nothing else of the environment leaves the command
  readonly env: Readonly<Record<string, string>>
}

// A variable that is set and not empty, as the kernel reads one
const setIn = (env: Env, name: string): string | undefined => {
  const value = env[name]
  return value === '' ? undefined : value
}

const kept = (env: Env, keep: (name: string) => boolean): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && keep(name)) {
      result[name] = value
    }
  }
  return result
}

// A daemon reads its own environment, not the command's: what the command's names choose travels with the session, the flags first
// The home is left out: the agent gets the home of its daemon from the daemon, which for --host and --port is another one
export const sessionChoices = (
  flags: { readonly employee?: string | undefined; readonly branch?: string | undefined },
  env: Env,
): SessionChoices => ({
  employee: flags.employee ?? setIn(env, 'BYTEBUREAU_EMPLOYEE'),
  branch: flags.branch ?? setIn(env, 'BYTEBUREAU_BRANCH'),
  env: kept(env, (name) => name.startsWith(OURS) && name !== 'BYTEBUREAU_HOME'),
})

// The environment of a daemon a command starts on demand: the command's, without the BYTEBUREAU_* names that choose for one run
// Kept, they would be the daemon's defaults, and every later run of any command would get them
export const daemonEnv = (env: Env): Record<string, string> =>
  kept(env, (name) => !name.startsWith(OURS) || DAEMON_OWN.has(name))
