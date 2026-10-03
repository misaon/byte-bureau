const DIGITS = /^\d+$/u

// The major of MAJOR[.MINOR[.PATCH]] after a caret; anything else has none
function wantedMajor(range: string): string | undefined {
  if (!range.startsWith('^')) {
    return undefined
  }
  const parts = range.slice(1).split('.')
  return parts.length <= 3 && parts.every((part) => DIGITS.test(part)) ? parts[0] : undefined
}

// The major of a version with a dot after it
function actualMajor(version: string): string | undefined {
  const [major, ...rest] = version.split('.')
  return rest.length > 0 && major !== undefined && DIGITS.test(major) ? major : undefined
}

// Only caret ranges are accepted for hostApi; anything else is incompatible by design
export function satisfiesMajor(range: string, version: string): boolean {
  const wanted = wantedMajor(range)
  return wanted !== undefined && wanted === actualMajor(version)
}
