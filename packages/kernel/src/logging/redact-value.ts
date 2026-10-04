import { REDACTED_FIELDS, SECRET_PATTERNS } from './redaction.js'

const MARK = '[REDACTED]'
// Levels the walk descends; what lies deeper is kept as it is
const MAX_DEPTH = 10

const isSecretName = (key: string): boolean => REDACTED_FIELDS.some((pattern) => pattern.test(key))

// The patterns are global, and replace starts each of them at the beginning of the text
function redactString(text: string): string {
  let redacted = text
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement)
  }
  return redacted
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function walk(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return redactString(value)
  }
  if (depth >= MAX_DEPTH) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => walk(item, depth + 1))
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSecretName(key) ? MARK : walk(item, depth + 1),
      ]),
    )
  }
  return value
}

// A JSON value with its secrets replaced: the value of a field named like a secret, and every secret-shaped run of text
export const redactValue = (value: unknown): unknown => walk(value, 0)
