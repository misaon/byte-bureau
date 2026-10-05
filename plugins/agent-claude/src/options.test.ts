import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import type { CreateSessionRequest } from '@bytebureau/plugin-api'
import { describe, expect, it, vi } from 'vitest'
import { CLAUDE_CONVENTIONS, optionsOf } from './options.js'
import { CANARY_KEY, employee, sessionRequest } from './testing/requests.js'

const canUseTool: CanUseTool = async () => {
  const denied = await Promise.resolve({ behavior: 'deny', message: 'not in this test' } as const)
  return denied
}

const optionsFor = (
  request: CreateSessionRequest,
  executable?: string,
): ReturnType<typeof optionsOf> =>
  optionsOf({ request, executable, abort: new AbortController(), hooks: {}, canUseTool })

describe(optionsOf, () => {
  it('runs a supervised employee in its workspace with its model, prompt and tools, asking before tools', () => {
    expect.hasAssertions()
    const options = optionsFor(sessionRequest())
    expect(options).toMatchObject({
      cwd: '/w',
      model: 'claude-opus-5-5',
      effort: 'high',
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: `You write TypeScript.\n\n${CLAUDE_CONVENTIONS}`,
      },
      allowedTools: ['Read', 'Edit'],
      disallowedTools: ['WebFetch'],
      includePartialMessages: true,
      permissionMode: 'default',
      settingSources: ['user', 'project', 'local'],
      mcpServers: {},
    })
    expect(options.env).toStrictEqual({ PATH: '/usr/bin', HOME: '/home/dev' })
    expect(Object.keys(options)).not.toStrictEqual(expect.arrayContaining(['resume']))
  })

  it('leaves out what the employee does not set, and lets an autonomous one run on the classifier', () => {
    expect.hasAssertions()
    const options = optionsFor(
      sessionRequest({
        employee: employee({ effort: null, maxTurns: 7, permissionMode: 'autonomous' }),
      }),
    )
    expect(options).not.toHaveProperty('effort')
    expect(options).toMatchObject({ maxTurns: 7, permissionMode: 'auto' })
    expect(options).not.toHaveProperty('pathToClaudeCodeExecutable')
  })

  it('refuses a yolo employee, which nothing isolates', () => {
    expect.hasAssertions()
    const request = sessionRequest({ employee: employee({ permissionMode: 'yolo' }) })
    expect(() => optionsFor(request)).toThrow(
      'yolo is refused: the workspace runtime has no isolation',
    )
  })
})

describe('the environment of the agent', () => {
  it('points a login profile with a directory at it, and no other profile', () => {
    expect.hasAssertions()
    const dir = {
      id: 'claude/work',
      providerId: 'claude',
      kind: 'login',
      configDir: '/h/profiles/claude/work',
    } as const
    expect(optionsFor(sessionRequest({ profile: dir })).env).toHaveProperty(
      'CLAUDE_CONFIG_DIR',
      '/h/profiles/claude/work',
    )
    expect(optionsFor(sessionRequest()).env).not.toHaveProperty('CLAUDE_CONFIG_DIR')
    const key = {
      id: 'claude/ci',
      providerId: 'claude',
      kind: 'api_key',
      configDir: '/h/x',
    } as const
    expect(optionsFor(sessionRequest({ profile: key })).env).not.toHaveProperty('CLAUDE_CONFIG_DIR')
  })

  it('hands on the key only because the request carried it, never one of the daemon', () => {
    expect.hasAssertions()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-of-the-daemon')
    try {
      const profile = { id: 'claude/ci', providerId: 'claude', kind: 'api_key' } as const
      const env = { PATH: '/usr/bin', ANTHROPIC_API_KEY: CANARY_KEY }
      expect(optionsFor(sessionRequest({ profile, env })).env).toStrictEqual(env)
      expect(optionsFor(sessionRequest()).env).not.toHaveProperty('ANTHROPIC_API_KEY')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('the provider options of a session', () => {
  it('resumes only a session of Claude, and runs the executable it was given', () => {
    expect.hasAssertions()
    const claude = sessionRequest({ resume: { providerId: 'claude', ref: 'abc' } })
    expect(optionsFor(claude, '/opt/bin/claude')).toMatchObject({
      resume: 'abc',
      pathToClaudeCodeExecutable: '/opt/bin/claude',
    })
    expect(
      optionsFor(sessionRequest({ resume: { providerId: 'fake', ref: 'x' } })),
    ).not.toHaveProperty('resume')
  })

  it('reads the setting sources of providers.claude, and refuses a key it does not know', () => {
    expect.hasAssertions()
    const project = sessionRequest({ providerConfig: { settingSources: ['project'] } })
    expect(optionsFor(project).settingSources).toStrictEqual(['project'])
    const unknown = sessionRequest({ providerConfig: { executable: 'claude', colour: 'blue' } })
    expect(() => optionsFor(unknown)).toThrow(/^providers\.claude: .*colour/u)
  })
})
