import { ApiError } from '@bytebureau/client'
import {
  defaultProjectConfig,
  type AskRecord,
  type EmployeeSpec,
  type HealthDto,
  type ProfileDto,
  type ProfileStatusDto,
  type ProjectDto,
  type SessionDto,
  type TurnDto,
  type UsageSnapshotDto,
} from '@bytebureau/protocol'

// Records as the daemon answers them; every field that may be null has a value, as the CLI sources spell no null
const AT = '2026-10-02T12:00:00.000Z'

export const PROJECT: ProjectDto = {
  id: 'p1',
  name: 'repo',
  path: '/repo',
  defaultBranch: 'main',
  config: defaultProjectConfig,
  createdAt: AT,
  updatedAt: AT,
}

const EMPLOYEE: EmployeeSpec = {
  id: 'developer',
  name: 'Developer',
  provider: 'fake',
  model: 'any',
  effort: 'medium',
  systemPrompt: '',
  tools: { allow: [], deny: [] },
  permissionMode: 'supervised',
  skills: [],
  appearance: {},
}

export const SESSION: SessionDto = {
  id: 's1',
  projectId: 'p1',
  title: 'Fix the build',
  employee: EMPLOYEE,
  providerId: 'fake',
  profileId: 'fake/work',
  workspace: {
    id: 's1',
    runtimeId: 'local',
    path: '/repo/.bytebureau/worktrees/s1',
    branch: 'bb/s1',
    baseRef: 'main',
  },
  externalRef: { providerId: 'fake', ref: 'r1' },
  status: 'ready',
  createdAt: AT,
  startedAt: AT,
  endedAt: AT,
}

export const TURN: TurnDto = {
  id: 'u1',
  sessionId: 's1',
  index: 0,
  prompt: { text: 'Fix the build' },
  status: 'completed',
  stopReason: 'end_turn',
  usage: { inputTokens: 10, outputTokens: 5 },
  startedAt: AT,
  endedAt: AT,
}

export const HEALTH: HealthDto = {
  status: 'ok',
  version: '1.2.3',
  startedAt: AT,
  checks: { store: 'ok', plugins: { loaded: 2, failed: 0 } },
}

export const ASK: AskRecord = {
  id: 'a1',
  sessionId: 's1',
  turnId: 'u1',
  kind: 'question',
  title: 'Export style',
  questions: [
    {
      id: 'q',
      header: 'Export',
      prompt: 'Should hello() be a named export?',
      options: [{ id: 'yes', label: 'Named export', recommended: true, evidence: [] }],
      multiSelect: false,
      allowOther: false,
    },
  ],
  policy: { onTimeout: 'wait', timeout: '30m' },
  recommendationSource: 'agent',
  status: 'answered',
  createdAt: AT,
  deadlineAt: AT,
  answer: { selected: ['yes'] },
  answeredAt: AT,
  answeredVia: 'cli',
}

export const PROFILE: ProfileDto = {
  id: 'fake/work',
  providerId: 'fake',
  name: 'work',
  kind: 'login',
  configDir: '/home/me/.bytebureau/profiles/fake/work',
  isDefault: true,
  createdAt: AT,
}

export const PROFILE_STATUS: ProfileStatusDto = {
  profileId: 'fake/work',
  state: 'loggedIn',
  checkedAt: AT,
}

export const SNAPSHOT: UsageSnapshotDto = {
  profileId: 'fake/work',
  rateLimit: { fiveHourPct: 40 },
  observedAt: AT,
}

// The failure a call of the client rejects with when the daemon answers with a problem
export const problemError = (status: number, code: string, detail: string): ApiError =>
  new ApiError(status, {
    type: `https://bytebureau.dev/problems/${code}`,
    title: 'T',
    status,
    detail,
    code,
  })
