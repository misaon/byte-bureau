import { SessionDto } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { ApiTestLayer, get, post } from './testing.js'
import { fakeProjectConfig, registeredWith } from './testing-sessions.js'

interface Refusal {
  readonly title: string
  readonly config: Record<string, unknown>
  readonly body: Record<string, unknown>
  readonly status: number
  readonly code: string
  readonly detail: string
}

const { developer } = fakeProjectConfig.employees
const YOLO = {
  ...fakeProjectConfig,
  employees: { developer: { ...developer, permissionMode: 'yolo' } },
}

// What the kernel refuses a session for, with the status and the code the API tells it as
const REFUSALS: Refusal[] = [
  {
    title: 'a provider nobody offers',
    config: fakeProjectConfig,
    body: { providerId: 'nobody' },
    status: 422,
    code: 'session_provider_missing',
    detail:
      'provider "nobody" is not available; available: fake, claude, acp:codex, acp:gemini, acp:opencode, acp:pi, acp:custom',
  },
  {
    title: 'an employee the project does not have',
    config: fakeProjectConfig,
    body: { employeeId: 'nobody' },
    status: 422,
    code: 'session_employee_missing',
    detail: 'employee "nobody" is not defined in bytebureau.json',
  },
  {
    title: 'permission mode yolo on the local runtime',
    config: YOLO,
    body: {},
    status: 403,
    code: 'session_yolo_refused',
    detail:
      'permission mode "yolo" is refused on the "local" runtime (isolation: none); container runtimes enable it later',
  },
]

it.layer(ApiTestLayer())('the refusals of POST /api/v1/sessions', (suite) => {
  suite.effect.each(REFUSALS)('refuses $title with $status $code and creates nothing', (refusal) =>
    Effect.gen(function* refuses() {
      const { project } = yield* registeredWith(refusal.config)
      const body = { projectId: project.id, title: 'x', ...refusal.body }
      const refused = yield* post('/sessions', body)
      assert.strictEqual(refused.status, refusal.status)
      assert.include(refused.type, 'application/problem+json')
      assert.containSubset(refused.body, { code: refusal.code, detail: refusal.detail })
      const listed = Schema.decodeUnknownSync(Schema.Array(SessionDto))(
        (yield* get('/sessions')).body,
      )
      assert.deepStrictEqual(
        listed.filter((session) => session.projectId === project.id),
        [],
      )
    }),
  )
})
