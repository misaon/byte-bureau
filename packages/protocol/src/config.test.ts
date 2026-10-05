import { describe, expect, it } from 'vitest'
import { decodeProjectConfig, decodeUserConfig, defaultProjectConfig } from './config.js'

const withTimeout = (askTimeout: string): unknown => ({
  ...defaultProjectConfig,
  employees: { developer: { ...defaultProjectConfig.employees['developer'], askTimeout } },
})

describe(decodeProjectConfig, () => {
  it('accepts the documented sample and fills nothing silently', () => {
    const config = decodeProjectConfig(defaultProjectConfig)
    expect(config.version).toBe(1)
    expect(config.employees['developer']).toMatchObject({ permissionMode: 'supervised' })
  })

  it('takes an ask timeout of a whole number and a unit only', () => {
    expect.hasAssertions()
    for (const accepted of ['500ms', '30s', '30m', '1h', '2 h']) {
      expect(() => decodeProjectConfig(withTimeout(accepted))).not.toThrow()
    }
    for (const refused of ['soon', '30', '1.5h', '30min', '-1m']) {
      expect(() => decodeProjectConfig(withTimeout(refused))).toThrow(/askTimeout/u)
    }
  })

  it('reads the passEnv list of a provider and leaves its other keys to the provider', () => {
    const providers = {
      claude: { executable: 'claude', passEnv: ['GH_TOKEN'], extra: { depth: 1 } },
    }
    const config = decodeProjectConfig({ ...defaultProjectConfig, providers })
    expect(config.providers).toStrictEqual(providers)
    const broken = { ...defaultProjectConfig, providers: { claude: { passEnv: 'GH_TOKEN' } } }
    expect(() => decodeProjectConfig(broken)).toThrow(/passEnv/u)
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

  it('accepts the projects and the commands the user trusts, and refuses anything else there', () => {
    const trust = { projects: ['/home/me/app'], commands: ['bun', '/opt/codex/bin/codex-acp'] }
    expect(decodeUserConfig({ trust }).trust).toStrictEqual(trust)
    expect(() => decodeUserConfig({ trust: { commands: 'bun' } })).toThrow(/commands/u)
    expect(() => decodeUserConfig({ trust: { everything: true } })).toThrow(/everything/u)
  })

  it('accepts the secrets backend of the user configuration and refuses an unknown one', () => {
    expect(decodeUserConfig({ secrets: { backend: 'file' } }).secrets).toStrictEqual({
      backend: 'file',
    })
    expect(() => decodeUserConfig({ secrets: { backend: 'vault' } })).toThrow(/backend/u)
  })
})

describe('the projects the user trusts', () => {
  it('refuses a trusted project named by a relative path, saying an absolute one is expected', () => {
    expect(() => decodeUserConfig({ trust: { projects: ['code/app'] } })).toThrow(
      /Expected an absolute path\n {2}at \["trust"\]\["projects"\]\[0\]/u,
    )
    const windows = { projects: [String.raw`C:\code\app`, String.raw`\\server\share\app`] }
    expect(decodeUserConfig({ trust: windows }).trust).toStrictEqual(windows)
  })
})
