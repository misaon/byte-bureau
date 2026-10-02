import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KERNEL_EVENT_TYPES } from './events.js'
import { configJsonSchema, eventsJsonSchema } from './json-schema.js'

const schemasDir = fileURLToPath(new URL('../schemas/', import.meta.url))
const readSchema = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(schemasDir, name), 'utf8'))
const definitionsOf = (document: Record<string, unknown>): Record<string, unknown> => {
  const definitions = document['$defs']
  return typeof definitions === 'object' && definitions !== null ? { ...definitions } : {}
}

describe('generated JSON Schema files', () => {
  it('config.json is up to date and strict', () => {
    const generated = configJsonSchema()
    expect(readSchema('config.json')).toStrictEqual(generated)
    expect(generated['$id']).toBe('https://bytebureau.dev/schema/v1/config.json')
    expect(generated['additionalProperties']).toBe(false)
  })

  it('events.json is up to date and lists every event type', () => {
    const generated = eventsJsonSchema()
    expect(readSchema('events.json')).toStrictEqual(generated)
    expect(generated['$defs']).toHaveProperty(['session.created'])
    expect(generated['$defs']).toHaveProperty(['message.assistant.delta'])
  })

  it('events.json defines every payload as a closed object', () => {
    expect.hasAssertions()
    const payloads = Object.entries(definitionsOf(eventsJsonSchema())).filter(
      ([name]) => name !== 'EventEnvelope',
    )
    expect(payloads).toHaveLength(KERNEL_EVENT_TYPES.length)
    for (const [name, definition] of payloads) {
      expect(definition, name).toMatchObject({ type: 'object', additionalProperties: false })
    }
  })

  it('publishes numbers as number or integer, without Infinity or NaN alternatives', () => {
    expect(JSON.stringify(configJsonSchema())).not.toMatch(/Infinity|NaN/u)
    expect(JSON.stringify(eventsJsonSchema())).not.toMatch(/Infinity|NaN/u)
  })
})
