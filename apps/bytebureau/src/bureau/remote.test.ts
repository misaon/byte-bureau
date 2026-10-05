import { ApiError } from '@bytebureau/client'
import { describe, expect, it } from 'vitest'
import { isRefusal } from '../commands/run-session.js'
import { describeError } from '../errors.js'
import { recordingClient, type Calls } from '../testing/recording-client.js'
import { problemError } from '../testing/records.js'
import type { Bureau } from './bureau.js'
import { remoteBureau } from './remote.js'

describe('problems of the daemon in the CLI', () => {
  it('counts a workspace, provider or missing-provider problem as a refusal and nothing else', () => {
    expect(isRefusal(problemError(422, 'workspace_not_a_repository', 'x'))).toBe(true)
    expect(isRefusal(problemError(502, 'provider_crash', 'x'))).toBe(true)
    expect(isRefusal(problemError(422, 'session_provider_missing', 'x'))).toBe(true)
    expect(isRefusal(problemError(409, 'session_invalid_transition', 'x'))).toBe(false)
    expect(isRefusal(problemError(503, 'store_unavailable', 'x'))).toBe(false)
  })

  it('counts a profile the kernel does not know or cannot use as a refusal', () => {
    expect(isRefusal(problemError(404, 'profile_not_found', 'x'))).toBe(true)
    expect(isRefusal(problemError(422, 'profile_invalid', 'x'))).toBe(true)
  })

  it('counts no answer, or an answer without a problem, as no refusal', () => {
    expect(isRefusal(new ApiError(0, undefined, 'http://127.0.0.1:1/api/v1/projects'))).toBe(false)
    expect(isRefusal(new ApiError(502, undefined, 'http://127.0.0.1:1/api/v1/projects'))).toBe(
      false,
    )
  })

  it('describes a problem with its detail and code, and a connection failure with its url', () => {
    expect(describeError(problemError(404, 'session_not_found', 'no session 42'))).toBe(
      'no session 42 (session_not_found)',
    )
    expect(describeError(new ApiError(0, undefined, 'http://127.0.0.1:1/api/v1/health'))).toBe(
      'cannot reach the daemon at http://127.0.0.1:1/api/v1/health',
    )
  })
})

const DAEMON_URL = 'http://127.0.0.1:4747'

// What a command asks of the Bureau, and the call of the client it comes to: its name and its arguments
interface Passed {
  readonly name: string
  readonly args: readonly unknown[]
  readonly ask: (bureau: Bureau) => Promise<void>
}

const ANSWER = { selected: ['yes'] }
const BODY = { projectId: 'p1', title: 'Fix the build' }
const PROFILE_BODY = { providerId: 'fake', name: 'key', kind: 'api_key', apiKey: 'sk-1' } as const

// The path of a project goes in the body the API registers it by; everything else goes on as it is
const PASSED: readonly Passed[] = [
  {
    name: 'projects.register',
    args: [{ path: '/repo' }],
    ask: async (bureau) => {
      await bureau.projects.register('/repo')
    },
  },
  {
    name: 'projects.list',
    args: [],
    ask: async (bureau) => {
      await bureau.projects.list()
    },
  },
  {
    name: 'projects.get',
    args: ['p1'],
    ask: async (bureau) => {
      await bureau.projects.get('p1')
    },
  },
  {
    name: 'projects.remove',
    args: ['p1'],
    ask: async (bureau) => {
      await bureau.projects.remove('p1')
    },
  },
  {
    name: 'sessions.create',
    args: [BODY],
    ask: async (bureau) => {
      await bureau.sessions.create(BODY)
    },
  },
  {
    name: 'sessions.prompt',
    args: ['s1', { text: 'go' }],
    ask: async (bureau) => {
      await bureau.sessions.prompt('s1', { text: 'go' })
    },
  },
  {
    name: 'sessions.interrupt',
    args: ['s1'],
    ask: async (bureau) => {
      await bureau.sessions.interrupt('s1')
    },
  },
  {
    name: 'sessions.stop',
    args: ['s1'],
    ask: async (bureau) => {
      await bureau.sessions.stop('s1')
    },
  },
  {
    name: 'sessions.complete',
    args: ['s1'],
    ask: async (bureau) => {
      await bureau.sessions.complete('s1')
    },
  },
  {
    name: 'sessions.resume',
    args: ['s1'],
    ask: async (bureau) => {
      await bureau.sessions.resume('s1')
    },
  },
  {
    name: 'sessions.list',
    args: [],
    ask: async (bureau) => {
      await bureau.sessions.list()
    },
  },
  {
    name: 'sessions.get',
    args: ['s1'],
    ask: async (bureau) => {
      await bureau.sessions.get('s1')
    },
  },
  {
    name: 'asks.pending',
    args: ['s1'],
    ask: async (bureau) => {
      await bureau.asks.pending('s1')
    },
  },
  {
    name: 'asks.get',
    args: ['a1'],
    ask: async (bureau) => {
      await bureau.asks.get('a1')
    },
  },
  {
    name: 'asks.answer',
    args: ['a1', ANSWER],
    ask: async (bureau) => {
      await bureau.asks.answer('a1', ANSWER)
    },
  },
  {
    name: 'profiles.list',
    args: [],
    ask: async (bureau) => {
      await bureau.profiles.list()
    },
  },
  {
    name: 'profiles.add',
    args: [PROFILE_BODY],
    ask: async (bureau) => {
      await bureau.profiles.add(PROFILE_BODY)
    },
  },
  {
    name: 'profiles.remove',
    args: ['fake/work', { purge: true }],
    ask: async (bureau) => {
      await bureau.profiles.remove('fake/work', { purge: true })
    },
  },
  {
    name: 'profiles.setDefault',
    args: ['fake/work'],
    ask: async (bureau) => {
      await bureau.profiles.setDefault('fake/work')
    },
  },
  {
    name: 'profiles.status',
    args: ['fake/work'],
    ask: async (bureau) => {
      await bureau.profiles.status('fake/work')
    },
  },
  {
    name: 'workspaces.list',
    args: ['p1'],
    ask: async (bureau) => {
      await bureau.workspaces.list('p1')
    },
  },
  {
    name: 'workspaces.prune',
    args: ['p1'],
    ask: async (bureau) => {
      await bureau.workspaces.prune('p1')
    },
  },
  {
    name: 'usage.session',
    args: ['s1'],
    ask: async (bureau) => {
      await bureau.usage.session('s1')
    },
  },
  {
    name: 'usage.profile',
    args: ['fake/work'],
    ask: async (bureau) => {
      await bureau.usage.profile('fake/work')
    },
  },
  {
    name: 'plugins.list',
    args: [],
    ask: async (bureau) => {
      await bureau.plugins.list()
    },
  },
  {
    name: 'plugins.providers',
    args: [],
    ask: async (bureau) => {
      await bureau.plugins.providers()
    },
  },
  {
    name: 'health.check',
    args: [],
    ask: async (bureau) => {
      await bureau.health.check()
    },
  },
  {
    name: 'close',
    args: [],
    ask: async (bureau) => {
      await bureau.close()
    },
  },
]

describe(remoteBureau, () => {
  it.each(PASSED)('passes $name on to the client of the daemon', async ({ name, args, ask }) => {
    expect.hasAssertions()
    const calls: Calls = []
    await ask(remoteBureau(recordingClient(calls), DAEMON_URL))
    expect(calls).toStrictEqual([[name, ...args]])
  })

  it('subscribes with the signal of the run, and gives up on a daemon gone for fifteen seconds', () => {
    const calls: Calls = []
    const { signal } = new AbortController()
    const filter = { sessionId: 's1', since: 0, ephemeral: false }
    remoteBureau(recordingClient(calls), DAEMON_URL).events.subscribe(filter, signal)
    expect(calls).toStrictEqual([['events.subscribe', filter, { signal, retryFor: 15_000 }]])
  })

  it('says which daemon it talks to', () => {
    expect(remoteBureau(recordingClient([]), DAEMON_URL).where).toStrictEqual({
      kind: 'daemon',
      url: DAEMON_URL,
    })
  })
})
