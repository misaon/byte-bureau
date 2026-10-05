import path from 'node:path'

// USER is how Claude Code finds its login in the macOS keychain
const FIXED = new Set([
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'TMPDIR',
  'TERM',
  'SSH_AUTH_SOCK',
  'TRACEPARENT',
])

const BYTEBUREAU = 'BYTEBUREAU_'

const isBytebureau = (name: string): boolean => name.startsWith(BYTEBUREAU)

// The BYTEBUREAU_* names that are the kernel's own: where it keeps its data, how much it logs, the runtime of its worktrees
// The kernel's environment gives them to an agent; no caller decides them
const KERNEL_OWN: ReadonlySet<string> = new Set([
  'BYTEBUREAU_HOME',
  'BYTEBUREAU_LOG_LEVEL',
  'BYTEBUREAU_WORKSPACE_RUNTIME',
])

const allowed = (name: string, extra: ReadonlySet<string>): boolean =>
  FIXED.has(name) || name.startsWith('LC_') || isBytebureau(name) || extra.has(name)

const pick = (
  source: Readonly<Record<string, string | undefined>>,
  keep: (name: string) => boolean,
): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && keep(name)) {
      result[name] = value
    }
  }
  return result
}

// PATH with its absolute directories alone: an empty or a relative entry would find a program in whatever directory the child runs in, a worktree among them
// A PATH left with none is dropped, as an empty one would search the working directory
const withAbsolutePath = (env: Record<string, string>): Record<string, string> => {
  const { PATH: value } = env
  if (value === undefined) {
    return env
  }
  const kept = value
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry))
    .join(path.delimiter)
  const others = Object.entries(env).filter(([name]) => name !== 'PATH')
  return kept === '' ? Object.fromEntries(others) : { ...Object.fromEntries(others), PATH: kept }
}

export function allowlistEnv(
  source: Readonly<Record<string, string | undefined>>,
  extra: readonly string[] = [],
): Record<string, string> {
  const extraSet = new Set(extra)
  return withAbsolutePath(pick(source, (name) => allowed(name, extraSet)))
}

// What a caller adds to an environment it does not own: the names of ByteBureau and nothing else, so it cannot decide PATH or HOME
// Nor the kernel's own names: a client of the API could point an agent at another home
export function bytebureauEnv(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return pick(source, (name) => isBytebureau(name) && !KERNEL_OWN.has(name))
}
