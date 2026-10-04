import { configJsonSchema, eventsJsonSchema } from '@bytebureau/protocol'
import { Effect } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { BureauApi } from '../api.js'

export const SchemasHandlers = HttpApiBuilder.group(BureauApi, 'schemas', (handlers) =>
  handlers
    .handle('config', () => Effect.sync(() => configJsonSchema()))
    .handle('events', () => Effect.sync(() => eventsJsonSchema())),
)
