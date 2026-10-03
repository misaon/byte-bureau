import { describe, expect, it } from 'vitest'
import { decodeEventPayload, EventPayloadError } from './events.js'

// What a decoding throws, or null when it does not
function thrown(decode: () => unknown): unknown {
  try {
    decode()
    return null
  } catch (error) {
    return error
  }
}

describe(decodeEventPayload, () => {
  it('returns the typed payload of a known event type', () => {
    const payload = decodeEventPayload('tool.started', {
      id: 'tool-1',
      name: 'Write',
      kind: 'builtin',
      input: { path: 'src/hello.ts' },
    })
    expect(payload.name).toBe('Write')
    expect(payload.kind).toBe('builtin')
  })

  it('refuses a field the schema does not know, as the published JSON Schema does', () => {
    const extended = { id: 'tool-1', name: 'Write', error: 'denied', retryAfterMs: 5 }
    expect(() => decodeEventPayload('tool.failed', extended)).toThrow(/retryAfterMs/u)
    const nested = { usage: { inputTokens: 1, outputTokens: 2, serviceTier: 'x' } }
    expect(() => decodeEventPayload('usage.updated', nested)).toThrow(/serviceTier/u)
  })

  it('rejects a payload that does not fit the schema of its type', () => {
    expect(() => decodeEventPayload('tool.failed', { id: 'tool-1', name: 'Write' })).toThrow(
      /error/u,
    )
    expect(() => decodeEventPayload('session.ready', { status: 'sleeping' })).toThrow(/status/u)
  })
})

describe('decodeEventPayload when the payload does not fit', () => {
  it('rejects a type outside the catalogue by name', () => {
    expect(() => decodeEventPayload('tool.exploded', {})).toThrow(
      'unknown kernel event type: tool.exploded',
    )
  })

  it('throws an EventPayloadError that names the type, whatever does not fit', () => {
    const failures = [
      thrown(() => decodeEventPayload('tool.exploded', {})),
      thrown(() => decodeEventPayload('session.ready', { status: 'sleeping' })),
    ]
    expect(failures.map((failure) => failure instanceof EventPayloadError)).toStrictEqual([
      true,
      true,
    ])
    expect(failures).toMatchObject([
      { name: 'EventPayloadError', type: 'tool.exploded' },
      { name: 'EventPayloadError', type: 'session.ready' },
    ])
  })
})
