import { redactByField, redactByPattern, type RedactionPattern } from '@logtape/redaction'
import type { LogRecord, Sink, TextFormatter } from '@logtape/logtape'

export const REDACTED_FIELDS: readonly RegExp[] = [
  /^(?:proxy-)?authorization$/iu,
  /^(?:set-)?cookie$/iu,
  /pass(?:word|phrase|wd)?$/iu,
  /token$/iu,
  /api[_-]?key/iu,
  /access[_-]?key/iu,
  /secret/iu,
  /private[_-]?key/iu,
  /^(?:anthropic|openai|github|slack)_.*(?:key|token)$/iu,
]

// Every pattern of the kernel replaces with text, so redactValue can apply it with String.prototype.replace as well
interface SecretPattern extends RedactionPattern {
  readonly replacement: string
}

const replacement = '[REDACTED]'
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { pattern: /sk-ant-[A-Za-z0-9_-]{8,}/gu, replacement },
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}/gu, replacement },
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/gu, replacement },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{4,}/gu, replacement },
  { pattern: /\bxox[abp]-[A-Za-z0-9-]{4,}/gu, replacement },
  { pattern: /\bAKIA[0-9A-Z]{12,}/gu, replacement },
  { pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{3,}/gu, replacement },
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
    replacement,
  },
  { pattern: /\bBearer [A-Za-z0-9._~+/-]+=*/giu, replacement: `Bearer ${replacement}` },
  // Any scheme, any case: https, ftp, postgres; userinfo stops at quotes and backslashes, so a JSON line stays valid
  {
    pattern: /(?<scheme>\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:"'\\]+:[^\s/@"'\\]+@/giu,
    replacement: `$<scheme>${replacement}@`,
  },
]

// The redactor stops descending here; what lies deeper is replaced by a marker
const LIMITS = { maxDepth: 10, maxProperties: 200 } as const

const isPlainRecord = (value: object): boolean => {
  const prototype = Reflect.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

type Walk = (value: unknown) => unknown

// The fields of an Error the redactor can see: name, message, stack, its own fields and its cause
const errorFields = (error: Error, walk: Walk): Record<string, unknown> => {
  const own = Object.entries(error).filter(([key]) => key !== 'cause')
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
    ...Object.fromEntries(own.map(([key, value]) => [key, walk(value)])),
    ...(error.cause === undefined ? {} : { cause: walk(error.cause) }),
  }
}

const isWalkable = (value: unknown): value is object =>
  typeof value === 'object' &&
  value !== null &&
  (value instanceof Error || Array.isArray(value) || isPlainRecord(value))

const containerOf = (value: object, walk: Walk): unknown => {
  if (value instanceof Error) {
    return errorFields(value, walk)
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => walk(item))
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]))
}

// A bigint becomes text, which the JSON formatter would otherwise throw on; an Error becomes a record the field redaction walks
// Only what is on the current path counts as a cycle; what lies deeper than the redactor looks is left to it
function plainValue(value: unknown, depth: number, path: WeakSet<object>): unknown {
  if (typeof value === 'bigint') {
    return value.toString()
  }
  if (!isWalkable(value) || depth > LIMITS.maxDepth) {
    return value
  }
  if (path.has(value)) {
    return '[Circular]'
  }
  path.add(value)
  const result = containerOf(value, (item) => plainValue(item, depth + 1, path))
  path.delete(value)
  return result
}

const plainProperties = (properties: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [key, plainValue(value, 1, new WeakSet())]),
  )

// The redactor carries over the disposal of the sink it wraps, which is what flushes a file on reset; so does this wrapper
export const redactFields = (sink: Sink): Sink => {
  const redacted = redactByField(sink, {
    fieldPatterns: [...REDACTED_FIELDS],
    action: 'delete',
    ...LIMITS,
  })
  const prepared = (record: LogRecord): void => {
    redacted({ ...record, properties: plainProperties(record.properties) })
  }
  return Object.assign(prepared, redacted)
}

export const redactText = (formatter: TextFormatter): TextFormatter =>
  redactByPattern(formatter, SECRET_PATTERNS)
