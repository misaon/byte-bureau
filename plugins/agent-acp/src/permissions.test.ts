import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk'
import type { AgentEvent, AskAnswer } from '@bytebureau/plugin-api'
import { describe, expect, it } from 'vitest'
import { PermissionBroker } from './permissions.js'

const SESSION = '0192f0c8-7b2e-7c3d-9a4b-000000000007'
const ONCE: PermissionOption = { optionId: 'allow', name: 'Allow', kind: 'allow_once' }
const ALWAYS: PermissionOption = { optionId: 'always', name: 'Always allow', kind: 'allow_always' }
const REJECT: PermissionOption = { optionId: 'deny', name: 'Deny', kind: 'reject_once' }

const request = (
  options: readonly PermissionOption[],
  toolCallId = 'call-1',
): RequestPermissionRequest => ({
  sessionId: 'fake-acp-1',
  toolCall: {
    toolCallId,
    title: 'Write src/hello.ts',
    kind: 'edit',
    status: 'pending',
    rawInput: { path: 'src/hello.ts' },
  },
  options: [...options],
})

const brokerTelling = (): { readonly broker: PermissionBroker; readonly told: AgentEvent[] } => {
  const told: AgentEvent[] = []
  const broker = new PermissionBroker(SESSION, (event) => {
    told.push(event)
  })
  return { broker, told }
}

// The options of an agent that named them its own way, as codex-acp does
const OWN_WAY: readonly PermissionOption[] = [
  { optionId: 'approved-for-session', name: 'Always', kind: 'allow_always' },
  { optionId: 'approved', name: 'Yes', kind: 'allow_once' },
  { optionId: 'abort', name: 'No', kind: 'reject_once' },
]

// What the agent hears once the answer to its request is given
const responseTo = async (
  options: readonly PermissionOption[],
  answer: AskAnswer,
): Promise<RequestPermissionResponse> => {
  const { broker } = brokerTelling()
  const pending = broker.request(request(options))
  broker.answer('call-1', answer)
  const response = await pending
  return response
}

const selected = (optionId: string): unknown => ({ outcome: { outcome: 'selected', optionId } })
const CANCELLED = { outcome: { outcome: 'cancelled' } }

const ASK = {
  id: 'call-1',
  sessionId: SESSION,
  turnId: null,
  kind: 'permission',
  title: 'Write src/hello.ts',
  questions: [
    {
      id: 'decision',
      header: 'Permission',
      prompt: 'Allow Write src/hello.ts?',
      options: [
        { id: 'allow', label: 'Allow', recommended: false, evidence: [] },
        { id: 'deny', label: 'Deny', recommended: false, evidence: [] },
      ],
      multiSelect: false,
      allowOther: false,
    },
  ],
  toolCall: { name: 'Write src/hello.ts', input: { path: 'src/hello.ts' } },
  policy: { onTimeout: 'wait', timeout: '30m' },
  recommendationSource: 'none',
  status: 'pending',
  deadlineAt: null,
}

describe('a permission the agent requests', () => {
  it('is told as a permission ask with the options of the agent, named by the tool call', async () => {
    expect.hasAssertions()
    const { broker, told } = brokerTelling()
    const pending = broker.request(request([ONCE, REJECT]))
    expect(told).toMatchObject([{ type: 'ask.requested', ask: ASK }])
    expect(told[0]).toHaveProperty('ask.createdAt', expect.stringMatching(/^\d{4}-\d\d-\d\dT/u))
    broker.answer('call-1', { selected: ['allow'] })
    await expect(pending).resolves.toStrictEqual(selected('allow'))
  })

  it('takes the option the answer selects, and the always option of the request when the answer says always', async () => {
    expect.hasAssertions()
    const always = { selected: ['allow'], remember: 'always' } as const
    await expect(responseTo([ONCE, ALWAYS, REJECT], { selected: ['deny'] })).resolves.toStrictEqual(
      selected('deny'),
    )
    await expect(responseTo([ONCE, ALWAYS, REJECT], always)).resolves.toStrictEqual(
      selected('always'),
    )
    await expect(responseTo([ONCE, REJECT], always)).resolves.toStrictEqual(selected('allow'))
  })

  it('maps the allow and deny of the kernel onto the kinds of the options an agent named its own way', async () => {
    expect.hasAssertions()
    await expect(responseTo(OWN_WAY, { selected: ['allow'] })).resolves.toStrictEqual(
      selected('approved'),
    )
    await expect(
      responseTo(OWN_WAY, { selected: 'other', otherText: 'not now' }),
    ).resolves.toStrictEqual(selected('abort'))
    await expect(responseTo([ONCE], { selected: ['deny'] })).resolves.toStrictEqual(CANCELLED)
  })
})

describe('a permission an agent names against its kinds', () => {
  it('follows the decision of the person by the kinds of the options, never by their names', async () => {
    expect.hasAssertions()
    const inverted: readonly PermissionOption[] = [
      { optionId: 'deny', name: 'Always', kind: 'allow_always' },
      { optionId: 'allow', name: 'No', kind: 'reject_once' },
    ]
    await expect(responseTo(inverted, { selected: ['deny'] })).resolves.toStrictEqual(
      selected('allow'),
    )
    await expect(responseTo(inverted, { selected: ['allow'] })).resolves.toStrictEqual(
      selected('deny'),
    )
  })
})

describe('a permission nobody answers', () => {
  it('is cancelled on interrupt or close, and an answer that comes later changes nothing', async () => {
    expect.hasAssertions()
    const { broker } = brokerTelling()
    const first = broker.request(request([ONCE, REJECT]))
    const again = broker.request(request([ONCE, REJECT]))
    await expect(first).resolves.toStrictEqual(CANCELLED)
    broker.cancelAll()
    broker.answer('call-1', { selected: ['allow'] })
    await expect(again).resolves.toStrictEqual(CANCELLED)
  })

  it('is cancelled when the agent takes the request back, and not asked at all when it already has', async () => {
    expect.hasAssertions()
    const { broker, told } = brokerTelling()
    const controller = new AbortController()
    const taken = broker.request(request([ONCE, REJECT]), controller.signal)
    controller.abort()
    broker.answer('call-1', { selected: ['allow'] })
    await expect(taken).resolves.toStrictEqual(CANCELLED)
    const late = broker.request(request([ONCE, REJECT], 'call-7'), AbortSignal.abort())
    await expect(late).resolves.toStrictEqual(CANCELLED)
    expect(told).toHaveLength(1)
  })
})
