import { JsonSchema, Schema } from 'effect'
import { ProjectConfig } from './config.js'
import { EventEnvelope, KernelEventSchemas } from './events.js'

const CONFIG_ID = 'https://bytebureau.dev/schema/v1/config.json'
const EVENTS_ID = 'https://bytebureau.dev/schema/v1/events.json'

/** JSON Schema (draft 2020-12) of the project configuration file */
export function configJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(ProjectConfig, { onExcessProperty: 'error' })
  return {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
    $id: CONFIG_ID,
    ...document.schema,
    $defs: document.definitions,
  }
}

/** JSON Schema (draft 2020-12) of the event envelope and of each kernel event payload, keyed by wire type */
export function eventsJsonSchema(): Record<string, unknown> {
  const envelope = Schema.toJsonSchemaDocument(EventEnvelope, { onExcessProperty: 'error' })
  const defs: Record<string, unknown> = { EventEnvelope: envelope.schema, ...envelope.definitions }
  for (const [type, schema] of Object.entries(KernelEventSchemas)) {
    const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: 'error' })
    defs[type] = document.schema
    Object.assign(defs, document.definitions)
  }
  return {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
    $id: EVENTS_ID,
    $ref: '#/$defs/EventEnvelope',
    $defs: defs,
  }
}
