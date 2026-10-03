import { describe, expect, it } from 'vitest'
import { decodeEventPayload } from './events.js'

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

  it('ignores a field the schema does not know, so a newer kernel can add to a payload', () => {
    const payload = decodeEventPayload('tool.failed', {
      id: 'tool-1',
      name: 'Write',
      error: 'denied',
      retryAfterMs: 5,
    })
    expect(payload.error).toBe('denied')
  })

  it('rejects a payload that does not fit the schema of its type', () => {
    expect(() => decodeEventPayload('tool.failed', { id: 'tool-1', name: 'Write' })).toThrow(
      /error/u,
    )
    expect(() => decodeEventPayload('session.ready', { status: 'sleeping' })).toThrow(/status/u)
  })

  it('rejects a type outside the catalogue by name', () => {
    expect(() => decodeEventPayload('tool.exploded', {})).toThrow(
      'unknown kernel event type: tool.exploded',
    )
  })
})
