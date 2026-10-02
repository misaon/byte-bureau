import { describe, expect, it } from 'vitest'
import { decodeProjectConfig, decodeUserConfig, defaultProjectConfig } from './config.js'

describe(decodeProjectConfig, () => {
  it('accepts the documented sample and fills nothing silently', () => {
    const config = decodeProjectConfig(defaultProjectConfig)
    expect(config.version).toBe(1)
    expect(config.employees['developer']).toMatchObject({ permissionMode: 'supervised' })
  })

  it('reports every problem with its path and rejects unknown keys', () => {
    const broken = { ...defaultProjectConfig, logging: { level: 'loud' }, extra: true }
    expect(() => decodeProjectConfig(broken)).toThrow(/logging.*level/u)
    expect(() => decodeProjectConfig(broken)).toThrow(/extra/u)
  })
})

describe(decodeUserConfig, () => {
  const userConfig = {
    server: { host: '127.0.0.1', port: 4747 },
    defaults: { provider: 'claude', profile: 'work' },
    profiles: {
      work: {
        providerId: 'claude',
        name: 'Work',
        kind: 'login',
        configDir: '/home/me/.claude-work',
      },
      ci: { providerId: 'claude', name: 'CI', kind: 'api_key' },
    },
    locale: 'cs',
    logging: { level: 'debug' },
    telemetry: { content: 'local', otlpEndpoint: 'http://localhost:4318' },
    ui: { theme: 'dark', panes: { left: 3 } },
  }

  it('decodes profiles, ui and the telemetry endpoint unchanged', () => {
    expect(decodeUserConfig(userConfig)).toStrictEqual(userConfig)
  })

  it('still rejects an unknown user key and a profile with an unknown kind', () => {
    const oauth = { profiles: { work: { ...userConfig.profiles.work, kind: 'oauth' } } }
    expect(() => decodeUserConfig({ ...userConfig, extra: true })).toThrow(/extra/u)
    expect(() => decodeUserConfig(oauth)).toThrow(/kind/u)
  })
})
