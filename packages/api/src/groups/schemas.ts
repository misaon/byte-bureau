import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { Authorization } from '../auth.js'
import { RequestValidation } from '../validation.js'

const JsonObject = Schema.Record(Schema.String, Schema.Unknown).annotate({
  title: 'JsonSchemaDocument',
})

export const SchemasGroup = HttpApiGroup.make('schemas')
  .add(
    HttpApiEndpoint.get('config', '/schemas/config.json', { success: JsonObject }),
    HttpApiEndpoint.get('events', '/schemas/events.json', { success: JsonObject }),
  )
  .middleware(Authorization)
  .middleware(RequestValidation)
