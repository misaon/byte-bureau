const FIXED = new Set(['PATH', 'HOME', 'LANG', 'TMPDIR', 'TERM', 'SSH_AUTH_SOCK', 'TRACEPARENT'])

const BYTEBUREAU = 'BYTEBUREAU_'

const isBytebureau = (name: string): boolean => name.startsWith(BYTEBUREAU)

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

export function allowlistEnv(
  source: Readonly<Record<string, string | undefined>>,
  extra: readonly string[] = [],
): Record<string, string> {
  const extraSet = new Set(extra)
  return pick(source, (name) => allowed(name, extraSet))
}

// What a caller adds to an environment it does not own: the names of ByteBureau and nothing else, so it cannot decide PATH or HOME
export function bytebureauEnv(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return pick(source, isBytebureau)
}
