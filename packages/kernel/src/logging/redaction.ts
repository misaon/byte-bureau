import { redactByField, redactByPattern, type RedactionPattern } from '@logtape/redaction'
import type { Sink, TextFormatter } from '@logtape/logtape'

export const REDACTED_FIELDS: readonly RegExp[] = [
  /^authorization$/iu,
  /^cookie$/iu,
  /pass(?:word|phrase)?$/iu,
  /token$/iu,
  /api[_-]?key/iu,
  /secret/iu,
  /private[_-]?key/iu,
  /^(?:anthropic|openai|github|slack)_.*(?:key|token)$/iu,
]

const replacement = '[REDACTED]'
export const SECRET_PATTERNS: readonly RedactionPattern[] = [
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
  {
    pattern: /(?<scheme>https?:\/\/)[^\s/@:"'\\]+:[^\s/@"'\\]+@/gu,
    replacement: `$<scheme>${replacement}@`,
  },
]

export const redactFields = (sink: Sink): Sink =>
  redactByField(sink, { fieldPatterns: [...REDACTED_FIELDS], action: 'delete' })
export const redactText = (formatter: TextFormatter): TextFormatter =>
  redactByPattern(formatter, SECRET_PATTERNS)
