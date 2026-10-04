import { EventLog } from '@bytebureau/kernel'
import { Effect, Stream } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { BureauApi } from '../api.js'
import { ApiConfig } from '../config.js'
import { buffered } from '../events/buffered.js'
import { filterOf, heartbeatEvent, toSseEvent } from '../events/sse.js'

export const EventsHandlers = HttpApiBuilder.group(BureauApi, 'events', (handlers) =>
  handlers.handle('stream', ({ query, headers }) =>
    Effect.gen(function* opensStream() {
      const { heartbeat } = yield* ApiConfig
      const log = yield* EventLog
      const events = buffered(log.subscribe(filterOf(query, headers['last-event-id']))).pipe(
        Stream.map(toSseEvent),
      )
      // Stream.tick fires at once and then every heartbeat; the first beat leaves with the response, so an idle client has its headers at once
      // The beats stop when the events end, so the response ends with them
      const beats = Stream.tick(heartbeat).pipe(Stream.map(() => heartbeatEvent()))
      return Stream.merge(events, beats, { haltStrategy: 'left' })
    }),
  ),
)
