import { jsonLinesFormatter, type LogRecord } from '@logtape/logtape'
import { describe, expect, it } from 'vitest'
import { REDACTED_FIELDS, redactFields, redactText, SECRET_PATTERNS } from './redaction.js'

const record = (properties: Record<string, unknown>, message = 'hello'): LogRecord => ({
  category: ['bb', 'test'],
  level: 'info',
  message: [message],
  rawMessage: message,
  timestamp: 0,
  properties,
})

const SECRET_NAMES = [
  'authorization',
  'Proxy-Authorization',
  'Cookie',
  'set-cookie',
  'password',
  'passphrase',
  'passwd',
  'accessToken',
  'x-api-key',
  'AWS_ACCESS_KEY_ID',
  'clientSecret',
  'private_key',
  'ANTHROPIC_API_KEY',
]
const ORDINARY_NAMES = ['sessionId', 'category', 'status', 'durationMs']

const SECRET_SAMPLES = [
  'sk-ant-api03-canary',
  'sk-proj-canary1234',
  'ghp_canary1234',
  'github_pat_canary',
  'xoxb-1-canary',
  'AKIAIOSFODNN7CANARY',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc',
  '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----',
  'Authorization: Bearer abc.DEF-123_canary=',
  'https://user:pw@example.com/x',
]
const ORDINARY_TEXT =
  '2026-10-02T12:00:00.000Z bb.store session 0199c2f1-7a3b-7c11-8f3e-2b1d4c5e6f70 task-12345678 risk-assessment /src/index.ts'

describe(redactFields, () => {
  it('drops secret-looking property names at any depth', () => {
    const seen: LogRecord[] = []
    const sink = redactFields((entry) => {
      seen.push(entry)
    })
    sink(
      record({
        apiKey: 'sk-ant-canary',
        nested: { authorization: 'Bearer x', keep: 1 },
        ANTHROPIC_API_KEY: 'y',
      }),
    )
    const properties = JSON.stringify(seen.map((entry) => entry.properties))
    expect(properties).not.toMatch(/canary|Bearer|ANTHROPIC/u)
    expect(properties).toContain('"keep":1')
  })
})

describe(redactText, () => {
  it('rewrites tokens, keys, JWTs, PEM blocks and URL credentials in formatted output', () => {
    expect.hasAssertions()
    const format = redactText(jsonLinesFormatter)
    const text = format(
      record(
        {},
        'sk-ant-api03-canary ghp_canary1234 github_pat_canary xoxb-1-canary AKIAIOSFODNN7CANARY eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc https://user:pw@example.com/x -----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----',
      ),
    )
    for (const canary of [
      'sk-ant-api03-canary',
      'ghp_canary1234',
      'github_pat_canary',
      'xoxb-1-canary',
      'AKIAIOSFODNN7CANARY',
      'eyJhbGciOiJIUzI1NiJ9',
      'user:pw@',
      'MIIE',
    ]) {
      expect(text).not.toContain(canary)
    }
    expect(text).toContain('[REDACTED]')
  })

  it('keeps a jsonl line valid: URL credentials never span quotes or JSON punctuation', () => {
    const format = redactText(jsonLinesFormatter)
    const line = format(
      record(
        { plugin: '@bytebureau/demo' },
        'fetch http://user:pw@example.com/x then http://localhost:3000',
      ),
    )
    expect(line).not.toContain('user:pw')
    expect(JSON.parse(line)).toMatchObject({
      message: 'fetch http://[REDACTED]@example.com/x then http://localhost:3000',
      properties: { plugin: '@bytebureau/demo' },
    })
  })
})

describe('redactText beyond tokens of a known shape', () => {
  it('redacts a bearer token in free text and the credentials of a URL whatever its scheme', () => {
    expect.hasAssertions()
    const format = redactText(jsonLinesFormatter)
    const line = format(
      record(
        {},
        'sent bearer abc.DEF-1 to HTTPS://joe:pw1@example.com, then ftp://ann:pw2@files.example.com and postgres://bob:pw3@db:5432/x',
      ),
    )
    for (const canary of ['abc.DEF-1', 'joe:pw1', 'ann:pw2', 'bob:pw3']) {
      expect(line).not.toContain(canary)
    }
    expect(JSON.parse(line)).toMatchObject({
      message:
        'sent Bearer [REDACTED] to HTTPS://[REDACTED]@example.com, then ftp://[REDACTED]@files.example.com and postgres://[REDACTED]@db:5432/x',
    })
  })
})

describe('the redacted field list', () => {
  it('has a sample name for every pattern', () => {
    expect(
      REDACTED_FIELDS.every((pattern) => SECRET_NAMES.some((name) => pattern.test(name))),
    ).toBe(true)
  })

  it('deletes the secret names and keeps the ordinary ones', () => {
    const seen: LogRecord[] = []
    const sink = redactFields((entry) => {
      seen.push(entry)
    })
    const properties = Object.fromEntries(
      [...SECRET_NAMES, ...ORDINARY_NAMES].map((name) => [name, 'v']),
    )
    sink(record(properties))
    expect(seen.flatMap((entry) => Object.keys(entry.properties))).toStrictEqual(ORDINARY_NAMES)
  })

  it('keeps token counters and deletes token credentials', () => {
    const seen: LogRecord[] = []
    const sink = redactFields((entry) => {
      seen.push(entry)
    })
    sink(
      record({
        inputTokens: 10,
        outputTokens: 4,
        maxTokens: 100,
        accessToken: 'x',
        api_token: 'y',
        TOKEN: 'z',
      }),
    )
    expect(seen.map((entry) => entry.properties)).toStrictEqual([
      { inputTokens: 10, outputTokens: 4, maxTokens: 100 },
    ])
  })
})

describe('the secret pattern list', () => {
  it('has a sample for every pattern and leaves ordinary log text alone', () => {
    expect.hasAssertions()
    for (const { pattern } of SECRET_PATTERNS) {
      expect(SECRET_SAMPLES.some((sample) => sample.search(pattern) !== -1)).toBe(true)
      expect(ORDINARY_TEXT.search(pattern)).toBe(-1)
    }
  })
})
