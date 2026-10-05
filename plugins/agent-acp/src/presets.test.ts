import { ProviderConfigError } from '@bytebureau/plugin-api'
import { describe, expect, it } from 'vitest'
import { presetOf } from './custom-preset.js'
import { PRESETS, providerIdOf } from './presets.js'

// The presets as the fact sheet lists them (§0, §2): the commands, the variables of a login and a key, the hints
const CODEX = {
  id: 'codex',
  displayName: 'Codex (ACP)',
  command: 'codex-acp',
  args: [],
  env: {},
  configDirEnv: 'CODEX_HOME',
  apiKeyEnv: 'OPENAI_API_KEY',
  installHint: 'install it with: npm install -g @agentclientprotocol/codex-acp',
  loginHint: 'codex login',
}
const GEMINI = {
  id: 'gemini',
  displayName: 'Gemini CLI (ACP)',
  command: 'gemini',
  args: ['--acp'],
  env: {},
  apiKeyEnv: 'GEMINI_API_KEY',
  installHint: 'install it with: npm install -g @google/gemini-cli',
  loginHint: 'gemini',
}
const OPENCODE = {
  id: 'opencode',
  displayName: 'OpenCode (ACP)',
  command: 'opencode',
  args: ['acp'],
  env: {},
  installHint: 'install it with: npm install -g opencode-ai',
  loginHint: 'opencode auth login',
}
const PI = {
  id: 'pi',
  displayName: 'pi (ACP)',
  command: 'pi-acp',
  args: [],
  env: {},
  installHint: 'install it with: npm install -g pi-acp @earendil-works/pi-coding-agent',
  loginHint: 'pi',
}

describe('the ACP presets', () => {
  it('run codex-acp, gemini --acp, opencode acp and pi-acp, with their install and login hints', () => {
    expect(PRESETS).toStrictEqual({ codex: CODEX, gemini: GEMINI, opencode: OPENCODE, pi: PI })
  })

  it('name each provider acp: and the preset', () => {
    const presets = ['codex', 'gemini', 'opencode', 'pi', 'custom'] as const
    expect(presets.map((preset) => providerIdOf(preset))).toStrictEqual([
      'acp:codex',
      'acp:gemini',
      'acp:opencode',
      'acp:pi',
      'acp:custom',
    ])
  })
})

describe('the preset a session runs', () => {
  it('is the built-in one without a section, and takes the overrides its own section gives', () => {
    expect(presetOf('opencode', {})).toStrictEqual(PRESETS.opencode)
    const overridden = { command: '/opt/codex-acp', args: ['--quiet'], env: { RUST_LOG: 'warn' } }
    expect(presetOf('codex', overridden)).toStrictEqual({ ...CODEX, ...overridden })
  })

  it('takes the variables of a login directory and a key, and the hints, from its section as well', () => {
    const overridden = { configDirEnv: 'PI_HOME', apiKeyEnv: 'PI_API_KEY', loginHint: 'pi /login' }
    expect(presetOf('pi', overridden)).toStrictEqual({ ...PI, ...overridden })
  })

  it('runs the custom command with what its section says, the hints it configures winning', () => {
    const custom = {
      command: '/usr/local/bin/my-agent',
      args: ['--acp'],
      env: { MY_AGENT_MODE: 'acp' },
      configDirEnv: 'MY_AGENT_HOME',
      loginHint: 'my-agent login',
    }
    expect(presetOf('custom', custom)).toStrictEqual({
      id: 'custom',
      displayName: 'Custom agent (ACP)',
      ...custom,
      installHint: 'install it, or point providers["acp:custom"].command at the agent to run',
    })
    expect(presetOf('custom', { command: 'my-agent' })).toMatchObject({
      args: [],
      env: {},
      loginHint: 'the login command of that agent',
    })
  })
})

describe('a provider section the adapter cannot run', () => {
  it('refuses a custom preset without a command, naming the key to set', () => {
    const message = 'providers["acp:custom"].command is not configured'
    expect(() => presetOf('custom', {})).toThrow(message)
    expect(() => presetOf('custom', { args: ['--acp'] })).toThrow(ProviderConfigError)
  })

  it('refuses a section it cannot read, naming the provider and the key', () => {
    expect(() => presetOf('codex', { executable: 'x' })).toThrow(
      /^providers\["acp:codex"\]: .*executable/u,
    )
    expect(() => presetOf('gemini', { args: 'acp' })).toThrow(/^providers\["acp:gemini"\]: args: /u)
    expect(() => presetOf('gemini', { args: 'acp' })).toThrow(ProviderConfigError)
  })
})
