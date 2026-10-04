import { nowIso, uuidv7, type EventFilter } from '@bytebureau/kernel'
import { EventEnvelope, type EventsQuery } from '@bytebureau/protocol'
import { Schema } from 'effect'

// One frame of the stream: the seq as the id of a durable event, the type as the event name, the envelope as the data
export const SseEvent = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  event: Schema.String,
  data: Schema.fromJsonString(EventEnvelope),
})
export type SseEvent = typeof SseEvent.Type

export const toSseEvent = (envelope: EventEnvelope): SseEvent =>
  envelope.seq === 0
    ? { event: envelope.type, data: envelope }
    : { id: String(envelope.seq), event: envelope.type, data: envelope }

// A heartbeat is an ephemeral envelope of its own type, so every frame of the stream decodes as an event
export const heartbeatEvent = (): SseEvent => {
  const at = nowIso()
  return {
    event: 'heartbeat',
    data: { seq: 0, id: uuidv7(), ts: at, type: 'heartbeat', payload: { at } },
  }
}

// An id this server sent is the digits of a seq; an empty or any other text is no id
const SEQ = /^\d+$/u

const seqOf = (lastEventId: string | undefined): number | undefined => {
  if (lastEventId === undefined || !SEQ.test(lastEventId)) {
    return undefined
  }
  const seq = Number(lastEventId)
  return Number.isSafeInteger(seq) ? seq : undefined
}

// The header of a resuming client wins over the query; anything that is not a whole number is ignored
export const sinceOf = (query: EventsQuery, lastEventId: string | undefined): number =>
  seqOf(lastEventId) ?? query.since ?? 0

// The types are comma-separated; with none listed the stream is not narrowed by type
const typesOf = (types: string | undefined): readonly string[] | undefined => {
  const listed = (types ?? '').split(',').filter((type) => type !== '')
  return listed.length === 0 ? undefined : listed
}

export const filterOf = (query: EventsQuery, lastEventId: string | undefined): EventFilter => {
  const types = typesOf(query.types)
  return {
    since: sinceOf(query, lastEventId),
    ...(query.session === undefined ? {} : { sessionId: query.session }),
    ...(query.project === undefined ? {} : { projectId: query.project }),
    ...(types === undefined ? {} : { types }),
  }
}
