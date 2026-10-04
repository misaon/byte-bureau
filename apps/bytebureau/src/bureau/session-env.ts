type Env = Readonly<Record<string, string | undefined>>

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

const ownVariables = (env: Env): Record<string, string> => {
  const own: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && name.startsWith('BYTEBUREAU_')) {
      own[name] = value
    }
  }
  return own
}

// A daemon reads its own environment, not the command's: what the command's names choose travels with the session, the flags first
// The log level and the workspace runtime stay the daemon's own
export const sessionChoices = (
  flags: { readonly employee?: string | undefined; readonly branch?: string | undefined },
  env: Env,
): SessionChoices => ({
  employee: flags.employee ?? setIn(env, 'BYTEBUREAU_EMPLOYEE'),
  branch: flags.branch ?? setIn(env, 'BYTEBUREAU_BRANCH'),
  env: ownVariables(env),
})
