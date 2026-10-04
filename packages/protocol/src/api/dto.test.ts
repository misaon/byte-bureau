import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { HealthDto, PluginStatusDto, SessionDto, TurnDto, WorkspaceInfoDto } from './dto.js'
import { CreateSessionBody, EventsFilter, EventsQuery } from './requests.js'

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

  it('accepts an events query with every filter and with none', () => {
    const full = {
      since: 12,
      session: session.id,
      project: session.projectId,
      types: 'turn.started,turn.completed',
    }
    expect(Schema.decodeUnknownSync(EventsQuery)(full)).toStrictEqual(full)
    expect(Schema.decodeUnknownSync(EventsQuery)({})).toStrictEqual({})
  })

  it.each([-1, 1.5])(
    'refuses a since of %d, in the query and in the filter of the socket',
    (since) => {
      expect(() => Schema.decodeUnknownSync(EventsQuery)({ since })).toThrow(/since/u)
      expect(() => Schema.decodeUnknownSync(EventsFilter)({ since })).toThrow(/since/u)
    },
  )

  it('takes a since of 0, the start of the log', () => {
    expect(Schema.decodeUnknownSync(EventsFilter)({ since: 0 })).toStrictEqual({ since: 0 })
  })
})
