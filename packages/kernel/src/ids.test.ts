import { describe, expect, it } from 'vitest'
import { nowIso, uuidv7 } from './ids.js'

describe(uuidv7, () => {
  it('produces time-ordered v7 ids', () => {
    const ids = Array.from({ length: 2000 }, () => uuidv7())
    expect(
      ids.every((id) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id),
      ),
    ).toBe(true)
    expect(ids.toSorted()).toStrictEqual(ids)
  })
})

describe(nowIso, () => {
  it('is ISO-8601 UTC with milliseconds', () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  })
})
