import type { ProfileRef } from '@bytebureau/plugin-api'

// A name is a path segment of the profiles directory, so the pattern of AddProfileBody holds here too
const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/u

export const isProfileName = (name: string): boolean => PROFILE_NAME.test(name)

// Readable on the command line and unique per provider: a name holds no slash, so the last one parts the two
export const profileIdOf = (providerId: string, name: string): string => `${providerId}/${name}`

// The ref of a session whose provider has no profile is the nameless login of Phase A; no profile id is it, as each holds a slash
export const NAMELESS_PROFILE_ID = 'default'

export const namelessRefOf = (providerId: string): ProfileRef => ({
  id: NAMELESS_PROFILE_ID,
  providerId,
  kind: 'login',
})
