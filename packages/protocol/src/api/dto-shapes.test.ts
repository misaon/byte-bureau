import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { defaultProjectConfig } from '../config.js'
import { HealthDto, PluginStatusDto, ProjectDto, SessionDto, TurnDto } from './dto.js'

const SESSION_ID = '0192f0a0-0000-7000-8000-000000000001'
const PROJECT_ID = '0192f0a0-0000-7000-8000-000000000002'
const AT = '2026-10-04T10:00:00.000Z'

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

// A session that has not started: every field that may be absent says so with null
const fresh = {
  id: SESSION_ID,
  projectId: PROJECT_ID,
  title: 'Create hello',
  employee,
  providerId: 'fake',
  profileId: null,
  workspace: null,
  externalRef: null,
  status: 'created',
  createdAt: AT,
  startedAt: null,
  endedAt: null,
}

const turn = {
  id: '0192f0a0-0000-7000-8000-000000000003',
  sessionId: SESSION_ID,
  index: 0,
  prompt: { text: 'hi' },
  status: 'running',
  stopReason: null,
  usage: null,
  startedAt: AT,
  endedAt: null,
}

const plugin = { name: 'fake-agent', version: '0.0.0', state: 'loaded', ports: [] }

const health = {
  status: 'ok',
  version: '0.1.0',
  startedAt: AT,
  checks: { store: 'ok', plugins: { loaded: 2, failed: 0 } },
}

interface ClosedSet {
  readonly what: string
  readonly schema: Schema.Top
  // A value the schema takes, and the same value with one field outside its closed set
  readonly taken: object
  readonly refused: object
}

const CLOSED: readonly ClosedSet[] = [
  {
    what: 'a session status',
    schema: SessionDto,
    taken: fresh,
    refused: { ...fresh, status: 'paused' },
  },
  {
    what: 'a turn status',
    schema: TurnDto,
    taken: turn,
    refused: { ...turn, status: 'cancelled' },
  },
  {
    what: 'a plugin state',
    schema: PluginStatusDto,
    taken: plugin,
    refused: { ...plugin, state: 'loading' },
  },
  {
    what: 'a health status',
    schema: HealthDto,
    taken: health,
    refused: { ...health, status: 'broken' },
  },
  {
    what: 'a store check',
    schema: HealthDto,
    taken: health,
    refused: { ...health, checks: { ...health.checks, store: 'unknown' } },
  },
]

describe('the closed sets of the API DTOs', () => {
  it.each(CLOSED)('take only the values of $what', ({ schema, taken, refused }) => {
    expect(Schema.decodeUnknownSync(schema)(taken)).toStrictEqual(taken)
    expect(() => Schema.decodeUnknownSync(schema)(refused)).toThrow(/Expected/u)
  })
})

describe('null as the absence of a value in the API DTOs', () => {
  it('takes null for every field of a session that may be absent', () => {
    expect(Schema.decodeUnknownSync(SessionDto)(fresh)).toStrictEqual(fresh)
  })

  it.each(['profileId', 'workspace', 'externalRef', 'startedAt', 'endedAt'])(
    'refuses a session without %s: absent is null, never a missing field',
    (field) => {
      const missing = Object.fromEntries(Object.entries(fresh).filter(([key]) => key !== field))
      expect(() => Schema.decodeUnknownSync(SessionDto)(missing)).toThrow(field)
    },
  )

  it('takes a turn under way, whose stop reason, usage and end are null', () => {
    expect(Schema.decodeUnknownSync(TurnDto)(turn)).toStrictEqual(turn)
  })
})

describe('the project DTO', () => {
  it('comes back the same through an encode and a decode, its configuration included', () => {
    const project = {
      id: PROJECT_ID,
      name: 'repo',
      path: '/tmp/repo',
      defaultBranch: 'main',
      config: defaultProjectConfig,
      createdAt: AT,
      updatedAt: AT,
    }
    const decoded = Schema.decodeUnknownSync(ProjectDto)(project)
    expect(
      Schema.decodeUnknownSync(ProjectDto)(Schema.encodeSync(ProjectDto)(decoded)),
    ).toStrictEqual(decoded)
    expect(Schema.encodeSync(ProjectDto)(decoded)).toStrictEqual(project)
  })
})
