import type { EventEnvelope } from '@bytebureau/protocol'
import { describe, expect, it } from 'vitest'
import { DeliveryBuffer } from './delivery-buffer.js'

const event = (seq: number, type: string): EventEnvelope => ({
  seq,
  id: `e${seq}-${type}`,
  ts: '2026-10-04T00:00:00.000Z',
  type,
  payload: {},
})

const ephemeral = (id: string): EventEnvelope => ({ ...event(0, 'delta'), id })

// A buffer of the capacity that has been handed the events one after the other
const filled = (capacity: number, events: readonly EventEnvelope[]): DeliveryBuffer => {
  const buffer = new DeliveryBuffer(capacity)
  for (const item of events) {
    buffer.push(item)
  }
  return buffer
}

const idsOf = (buffer: DeliveryBuffer): string[] => buffer.drain().map((item) => item.id)

describe(DeliveryBuffer, () => {
  it('hands events out in the order they came while nothing is dropped', () => {
    const buffer = filled(3, [event(1, 'a'), event(0, 'delta'), event(2, 'b')])
    expect(idsOf(buffer)).toStrictEqual(['e1-a', 'e0-delta', 'e2-b'])
    expect(buffer.drain()).toStrictEqual([])
  })

  it('drops the oldest ephemeral event above the capacity and keeps every durable one', () => {
    const arrivals = [event(1, 'a'), ephemeral('d1'), ephemeral('d2'), event(2, 'b')]
    const buffer = filled(2, [...arrivals, ephemeral('d3'), event(3, 'c')])
    expect(idsOf(buffer)).toStrictEqual(['e1-a', 'd2', 'e2-b', 'd3', 'e3-c'])
    expect(buffer.dropped).toBe(1)
  })

  it('keeps no ephemeral event with a capacity of 0, and still every durable one', () => {
    const buffer = filled(0, [event(1, 'a'), event(0, 'delta'), event(2, 'b')])
    expect(idsOf(buffer)).toStrictEqual(['e1-a', 'e2-b'])
    expect(buffer.dropped).toBe(1)
  })

  it('makes room for ephemeral events again once the ones it holds are taken', () => {
    const buffer = filled(1, [event(0, 'delta')])
    buffer.drain()
    buffer.push(event(0, 'delta'))
    expect(buffer.drain()).toHaveLength(1)
    expect(buffer.dropped).toBe(0)
  })
})
