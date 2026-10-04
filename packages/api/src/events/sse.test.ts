import type { EventEnvelope } from '@bytebureau/protocol'
import { describe, expect, it } from 'vitest'
import { filterOf, heartbeatEvent, sinceOf, toSseEvent } from './sse.js'

const envelope = (seq: number): EventEnvelope => ({
  seq,
  id: 'e1',
  ts: '2026-10-04T00:00:00.000Z',
  type: 'turn.started',
  payload: {},
})

describe(toSseEvent, () => {
  it('names a durable event by its seq and gives an ephemeral one no id', () => {
    const durable = { id: '7', event: 'turn.started', data: envelope(7) }
    expect(toSseEvent(envelope(7))).toStrictEqual(durable)
    expect(toSseEvent(envelope(0))).toStrictEqual({ event: 'turn.started', data: envelope(0) })
  })
})

describe(heartbeatEvent, () => {
  it('is an ephemeral envelope of the type heartbeat, stamped with the time of the beat', () => {
    const { id, event, data } = heartbeatEvent()
    expect(id).toBeUndefined()
    expect(event).toBe('heartbeat')
    expect(data).toMatchObject({ seq: 0, type: 'heartbeat', payload: { at: data.ts } })
  })
})

describe(sinceOf, () => {
  it.each([
    { given: 'nothing', query: {}, header: undefined, expected: 0 },
    { given: 'the query alone', query: { since: 5 }, header: undefined, expected: 5 },
    { given: 'the header over the query', query: { since: 5 }, header: '3', expected: 3 },
    { given: 'a header of 0 over the query', query: { since: 5 }, header: '0', expected: 0 },
    { given: 'the header alone', query: {}, header: '12', expected: 12 },
    { given: 'a header that is no number', query: { since: 5 }, header: 'soon', expected: 5 },
    { given: 'an empty header', query: { since: 5 }, header: '', expected: 5 },
    { given: 'a negative header', query: { since: 5 }, header: '-1', expected: 5 },
    { given: 'a header with a fraction', query: { since: 5 }, header: '2.5', expected: 5 },
    { given: 'a header too big', query: { since: 5 }, header: '9007199254740993', expected: 5 },
  ])('reads $given', ({ query, header, expected }) => {
    expect(sinceOf(query, header)).toBe(expected)
  })
})

describe(filterOf, () => {
  it('maps the query to the filter of the kernel, the header deciding where the stream resumes', () => {
    const query = { since: 4, session: 's1', project: 'p1', types: 'turn.started,,session.ready,' }
    expect(filterOf(query, '9')).toStrictEqual({
      since: 9,
      sessionId: 's1',
      projectId: 'p1',
      types: ['turn.started', 'session.ready'],
    })
  })

  it.each([
    {
      given: 'names with blanks around them',
      query: { types: ' session.created, session.ready ,tool.started' },
      header: undefined,
      expected: { since: 0, types: ['session.created', 'session.ready', 'tool.started'] },
    },
    { given: 'nothing', query: {}, header: undefined, expected: { since: 0 } },
    {
      given: 'a list of no type',
      query: { types: ',' },
      header: undefined,
      expected: { since: 0 },
    },
    {
      given: 'a list of blanks',
      query: { types: ' , ' },
      header: undefined,
      expected: { since: 0 },
    },
  ])('maps $given to the filter of the kernel', ({ query, header, expected }) => {
    expect(filterOf(query, header)).toStrictEqual(expected)
  })
})
