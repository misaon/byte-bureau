import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  HealthDto,
  PluginStatusDto,
  ProfileDto,
  ProfileStatusDto,
  ProviderDto,
  SessionDto,
  TurnDto,
  UsageSnapshotDto,
  WorkspaceInfoDto,
} from './dto.js'
import {
  AddProfileBody,
  CreateSessionBody,
  EventsFilter,
  EventsQuery,
  ProfileIdParam,
  RemoveProfileQuery,
} from './requests.js'

const PROFILE_ID = 'claude/work'

const employee = {
  id: 'developer',
  name: 'Developer',
  provider: 'fake',
  model: 'any',
  effort: null,
  systemPrompt: '',
  tools: { allow: [], deny: [] },
  permissionMode: 'supervised',
  skills: [],
  appearance: {},
}

const session = {
  id: '0192f0a0-0000-7000-8000-000000000001',
  projectId: '0192f0a0-0000-7000-8000-000000000002',
  title: 'Create hello',
  employee,
  providerId: 'fake',
  profileId: null,
  workspace: {
    id: '0192f0a0-0000-7000-8000-000000000001',
    runtimeId: 'local',
    path: '/tmp/repo/.bytebureau/worktrees/x',
    branch: 'bb/create-hello',
    baseRef: 'main',
  },
  externalRef: null,
  status: 'ready',
  createdAt: '2026-10-04T10:00:00.000Z',
  startedAt: null,
  endedAt: null,
}

describe('the API DTO schemas', () => {
  it('decodes a session with a workspace and no external ref', () => {
    expect(Schema.decodeUnknownSync(SessionDto)(session)).toStrictEqual(session)
  })

  it('refuses a session with an unknown field', () => {
    expect(() =>
      Schema.decodeUnknownSync(SessionDto)({ ...session, extra: 1 }, { onExcessProperty: 'error' }),
    ).toThrow(/extra/u)
  })

  it('decodes a turn whose usage is null and a plugin status without a reason', () => {
    const turn = {
      id: '0192f0a0-0000-7000-8000-000000000003',
      sessionId: session.id,
      index: 0,
      prompt: { text: 'hi' },
      status: 'completed',
      stopReason: 'end_turn',
      usage: null,
      startedAt: '2026-10-04T10:00:00.000Z',
      endedAt: '2026-10-04T10:00:01.000Z',
    }
    expect(Schema.decodeUnknownSync(TurnDto)(turn)).toStrictEqual(turn)
    const plugin = {
      name: 'fake-agent',
      version: '0.0.0',
      state: 'loaded',
      ports: ['agentProvider'],
    }
    expect(Schema.decodeUnknownSync(PluginStatusDto)(plugin)).toStrictEqual(plugin)
  })

  it('decodes a degraded health report', () => {
    const health = {
      status: 'degraded',
      version: '0.1.0',
      startedAt: '2026-10-04T10:00:00.000Z',
      checks: { store: 'failed', plugins: { loaded: 2, failed: 1 } },
    }
    expect(Schema.decodeUnknownSync(HealthDto)(health)).toStrictEqual(health)
  })
})

describe('the profile DTOs', () => {
  it('decodes a profile, a profile status and a usage snapshot, and refuses a kind outside the two', () => {
    const profile = Schema.decodeUnknownSync(ProfileDto)({
      id: PROFILE_ID,
      providerId: 'claude',
      name: 'work',
      kind: 'login',
      configDir: '/home/me/.bytebureau/profiles/claude/work',
      isDefault: true,
      createdAt: '2026-10-04T12:00:00.000Z',
    })
    expect(profile.kind).toBe('login')
    expect(() => Schema.decodeUnknownSync(ProfileDto)({ ...profile, kind: 'oauth' })).toThrow(
      /kind/u,
    )
    const status = Schema.decodeUnknownSync(ProfileStatusDto)({
      profileId: PROFILE_ID,
      state: 'loggedOut',
      hint: 'CLAUDE_CONFIG_DIR=/home/me/.bytebureau/profiles/claude/work claude /login',
      checkedAt: '2026-10-04T12:00:01.000Z',
    })
    expect(status.state).toBe('loggedOut')
    const snapshot = Schema.decodeUnknownSync(UsageSnapshotDto)({
      profileId: PROFILE_ID,
      rateLimit: { fiveHourPct: 12.5 },
      observedAt: null,
    })
    expect(snapshot.observedAt).toBeNull()
  })

  it('tells whether a provider takes API-key profiles', () => {
    expect(
      Schema.decodeUnknownSync(ProviderDto)({
        id: 'claude',
        displayName: 'Claude Code',
        supportsApiKey: true,
      }).supportsApiKey,
    ).toBe(true)
  })
})

describe('the worktree DTO', () => {
  const worktree = {
    sessionId: session.id,
    projectId: session.projectId,
    path: '/tmp/repo/.bytebureau/worktrees/x',
    branch: 'bb/create-hello',
    baseRef: 'main',
    sessionStatus: 'completed',
    exists: true,
  }

  it('carries the status of its session as one of the session statuses', () => {
    expect(Schema.decodeUnknownSync(WorkspaceInfoDto)(worktree)).toStrictEqual(worktree)
    expect(() =>
      Schema.decodeUnknownSync(WorkspaceInfoDto)({ ...worktree, sessionStatus: 'dancing' }),
    ).toThrow(/sessionStatus/u)
  })
})

describe('the API request schemas', () => {
  it('accepts a session creation with only the required fields', () => {
    const body = { projectId: session.projectId, title: 'x' }
    expect(Schema.decodeUnknownSync(CreateSessionBody)(body)).toStrictEqual(body)
  })

  it('accepts an events query with every filter and with none, its since read from the text of the query', () => {
    const filters = {
      session: session.id,
      project: session.projectId,
      types: 'turn.started,turn.completed',
    }
    const query = Schema.decodeUnknownSync(EventsQuery)({ since: '12', ...filters })
    expect(query).toStrictEqual({ since: 12, ...filters })
    expect(Schema.decodeUnknownSync(EventsQuery)({})).toStrictEqual({})
  })

  it.each([-1, 1.5])(
    'refuses a since of %d, in the query and in the filter of the socket',
    (since) => {
      expect(() => Schema.decodeUnknownSync(EventsQuery)({ since: String(since) })).toThrow(
        /since/u,
      )
      expect(() => Schema.decodeUnknownSync(EventsFilter)({ since })).toThrow(/since/u)
    },
  )

  it.each(['+5', '1e3', ' 5', ''])('refuses %j as the text of a since in the query', (since) => {
    expect(() => Schema.decodeUnknownSync(EventsQuery)({ since })).toThrow(/since/u)
  })

  it('takes a since of 0, the start of the log', () => {
    expect(Schema.decodeUnknownSync(EventsQuery)({ since: '0' })).toStrictEqual({ since: 0 })
    expect(Schema.decodeUnknownSync(EventsFilter)({ since: 0 })).toStrictEqual({ since: 0 })
  })
})

describe('the profile request schemas', () => {
  it('decodes the body that adds a profile, with the key and the default optional', () => {
    const body = Schema.decodeUnknownSync(AddProfileBody)({
      providerId: 'claude',
      name: 'work',
      kind: 'login',
    })
    expect(body).toStrictEqual({ providerId: 'claude', name: 'work', kind: 'login' })
    expect(
      Schema.decodeUnknownSync(AddProfileBody)({
        providerId: 'acp:codex',
        name: 'key',
        kind: 'api_key',
        apiKey: 'sk-test',
        makeDefault: true,
      }).makeDefault,
    ).toBe(true)
    expect(() =>
      Schema.decodeUnknownSync(AddProfileBody)({
        providerId: 'claude',
        name: 'Work Profile',
        kind: 'login',
      }),
    ).toThrow(/name/u)
  })

  it('reads the profile of a path and the purge of a query as the text they are', () => {
    expect(Schema.decodeUnknownSync(ProfileIdParam)({ id: PROFILE_ID })).toStrictEqual({
      id: PROFILE_ID,
    })
    expect(Schema.decodeUnknownSync(RemoveProfileQuery)({})).toStrictEqual({})
    expect(Schema.decodeUnknownSync(RemoveProfileQuery)({ purge: 'true' })).toStrictEqual({
      purge: 'true',
    })
    expect(() => Schema.decodeUnknownSync(RemoveProfileQuery)({ purge: 'yes' })).toThrow(/purge/u)
  })
})

describe('the name of a profile', () => {
  it.each(['a', '0', 'work-2', 'a'.repeat(32)])('takes %j', (name) => {
    const body = { providerId: 'claude', name, kind: 'login' }
    expect(Schema.decodeUnknownSync(AddProfileBody)(body)).toStrictEqual(body)
  })

  it.each(['', '-work', 'a'.repeat(33), 'under_score'])(
    'refuses %j, since it is a path segment',
    (name) => {
      expect(() =>
        Schema.decodeUnknownSync(AddProfileBody)({ providerId: 'claude', name, kind: 'login' }),
      ).toThrow(/name/u)
    },
  )
})
