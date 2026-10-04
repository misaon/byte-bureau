import { describe, expect, it } from 'vitest'
import { redactValue } from './redact-value.js'

const DEEP_SECRET = 'sk-ant-deep-secret-1234'
// Eleven levels of nesting with the secret at the bottom
const PATH = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
]

// One record per key around the value, the last key innermost
function nested(keys: readonly string[], value: unknown): unknown {
  let inner = value
  for (const key of keys.toReversed()) {
    inner = { [key]: inner }
  }
  return inner
}

// The value at the end of the path, read without trusting the shape of what holds it
function valueAt(value: unknown, keys: readonly string[]): unknown {
  let current = value
  for (const key of keys) {
    current =
      typeof current === 'object' && current !== null ? Reflect.get(current, key) : undefined
  }
  return current
}

describe(redactValue, () => {
  it('replaces the value of a secret-named field and a secret inside a string', () => {
    expect(
      redactValue({
        input: { command: 'curl -H "Authorization: Bearer abc.def-ghi" https://x', api_key: 'k' },
        text: 'use sk-ant-api03-abcdefghij and ghp_abcdefghijklmnop',
        env: { ANTHROPIC_API_KEY: 'sk-ant-zzzzzzzzzz' },
      }),
    ).toStrictEqual({
      input: {
        command: 'curl -H "Authorization: Bearer [REDACTED]" https://x',
        api_key: '[REDACTED]',
      },
      text: 'use [REDACTED] and [REDACTED]',
      env: { ANTHROPIC_API_KEY: '[REDACTED]' },
    })
  })

  it('leaves a payload without secrets as it was, arrays and nulls included', () => {
    const payload = {
      status: 'ready',
      model: null,
      tools: ['Read', 'Write'],
      usage: { inputTokens: 3 },
    }
    expect(redactValue(payload)).toStrictEqual(payload)
  })

  it('stops ten levels deep and keeps what lies deeper', () => {
    const redacted = redactValue(nested(PATH, DEEP_SECRET))
    expect(valueAt(redacted, PATH)).toBe(DEEP_SECRET)
  })
})
