import { EventsQuery } from '@bytebureau/protocol'
import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api'
import { Authorization } from '../auth.js'
import { SseEvent } from '../events/sse.js'
import { RequestValidation } from '../validation.js'

export const EventsGroup = HttpApiGroup.make('events')
  .add(
    HttpApiEndpoint.get('stream', '/events', {
      query: EventsQuery,
      headers: { 'last-event-id': Schema.optionalKey(Schema.String) },
      success: HttpApiSchema.StreamSse({ events: SseEvent }),
    }),
  )
  .middleware(Authorization)
  .middleware(RequestValidation)
