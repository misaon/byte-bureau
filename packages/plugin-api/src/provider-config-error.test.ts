import { describe, expect, it } from 'vitest'
import { ProviderConfigError } from './provider-config-error.js'

describe(ProviderConfigError, () => {
  it('is an error whose name and message tell the reason the configuration cannot be used', () => {
    const error = new ProviderConfigError('providers["acp:custom"].command is not configured')
    expect(error).toBeInstanceOf(Error)
    expect([error.name, error.message, error.reason]).toStrictEqual([
      'ProviderConfigError',
      'providers["acp:custom"].command is not configured',
      'providers["acp:custom"].command is not configured',
    ])
  })
})
