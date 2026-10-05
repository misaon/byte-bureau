import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { ProfileDto } from './dto.js'
import { AddProfileBody } from './requests.js'

const PROFILE = {
  id: 'claude/work',
  providerId: 'claude',
  name: 'work',
  kind: 'login',
  configDir: null,
  isDefault: false,
  createdAt: '2026-10-04T12:00:00.000Z',
}
const BODY = { providerId: 'claude', name: 'work', kind: 'login' }
const STRICT = { onExcessProperty: 'error' } as const

const profileOf = (input: Readonly<Record<string, unknown>>): unknown =>
  Schema.decodeUnknownSync(ProfileDto)(input)
const bodyOf = (input: Readonly<Record<string, unknown>>, options = {}): unknown =>
  Schema.decodeUnknownSync(AddProfileBody)(input, options)

describe('a profile DTO that does not fit', () => {
  it('is refused for a name that is no text and for a kind outside the two, naming the key', () => {
    expect(() => profileOf({ ...PROFILE, name: 42 })).toThrow(/at \["name"\]/u)
    expect(() => profileOf({ ...PROFILE, kind: 'oauth' })).toThrow(
      /"login" \| "api_key"\n {2}at \["kind"\]/u,
    )
  })

  it('drops a key it does not know, and refuses it when decoded strictly', () => {
    expect(profileOf({ ...PROFILE, token: 'x' })).toStrictEqual(PROFILE)
    expect(() => Schema.decodeUnknownSync(ProfileDto)({ ...PROFILE, token: 'x' }, STRICT)).toThrow(
      /at \["token"\]/u,
    )
  })
})

describe('a body that adds a profile and does not fit', () => {
  it('is refused for a name that is no path segment and for a kind outside the two, naming the key', () => {
    expect(() => bodyOf({ ...BODY, name: 'Work/Profile' })).toThrow(/at \["name"\]/u)
    expect(() => bodyOf({ ...BODY, kind: 'oauth' })).toThrow(
      /"login" \| "api_key"\n {2}at \["kind"\]/u,
    )
  })

  it('drops a key it does not know, so a misspelt key is never taken for one, and refuses it when decoded strictly', () => {
    expect(bodyOf({ ...BODY, api_key: 'sk-misspelt' })).toStrictEqual(BODY)
    expect(() => bodyOf({ ...BODY, api_key: 'sk-misspelt' }, STRICT)).toThrow(/at \["api_key"\]/u)
  })
})
