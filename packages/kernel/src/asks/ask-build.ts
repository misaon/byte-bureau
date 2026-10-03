import type { Ask, AskAnswer, AskOption, AskQuestion, PermissionMode } from '@bytebureau/protocol'
import { nowIso, uuidv7 } from '../ids.js'
import { parseDuration, recommendForPermission, type ToolCall } from './policy.js'

export const DENY_ON_TIMEOUT_MESSAGE = 'nobody available to approve; do not retry'

export interface OpenAskInput {
  readonly sessionId: string
  readonly turnId: string | null
  readonly kind: 'question' | 'permission'
  readonly title: string
  readonly questions: readonly AskQuestion[]
  readonly toolCall?: ToolCall | undefined
  readonly permissionMode: PermissionMode
  readonly askTimeout: string
  readonly workspacePath: string
  readonly recommendationSource?: 'agent' | 'none' | undefined
}

interface Questions {
  readonly questions: readonly AskQuestion[]
  readonly recommendationSource: Ask['recommendationSource']
}

// A permission is always allow or deny; the rules recommend one of them, or neither
const permissionQuestions = (
  toolCall: ToolCall,
  workspacePath: string,
  mode: PermissionMode,
): Questions => {
  const { recommended, ruleId } = recommendForPermission(toolCall, workspacePath, mode)
  const option = (id: 'allow' | 'deny', label: string): AskOption => ({
    id,
    label,
    recommended: recommended === id,
    evidence: recommended === id && ruleId !== null ? [{ kind: 'rule', ref: ruleId }] : [],
  })
  const question: AskQuestion = {
    id: 'permission',
    header: 'Permission',
    prompt: `${toolCall.name}: allow this tool call?`,
    options: [option('allow', 'Allow'), option('deny', 'Deny')],
    multiSelect: false,
    allowOther: false,
  }
  return { questions: [question], recommendationSource: recommended === null ? 'none' : 'policy' }
}

const hasRecommendation = (questions: readonly AskQuestion[]): boolean =>
  questions.some((question) => question.options.some((option) => option.recommended))

// A permission for a tool call gets the questions the rules derive; any other ask keeps the ones it came with
const questionsOf = (input: OpenAskInput): Questions => {
  if (input.kind === 'permission' && input.toolCall !== undefined) {
    return permissionQuestions(input.toolCall, input.workspacePath, input.permissionMode)
  }
  const source = hasRecommendation(input.questions)
    ? (input.recommendationSource ?? 'agent')
    : 'none'
  return { questions: input.questions, recommendationSource: source }
}

// Supervised employees are waited for; the others get the fallback of the kind of ask once the timeout is over
const policyFor = (input: OpenAskInput): Ask['policy'] => {
  if (input.permissionMode === 'supervised') {
    return { onTimeout: 'wait', timeout: input.askTimeout }
  }
  return {
    onTimeout: input.kind === 'question' ? 'recommended' : 'deny',
    timeout: input.askTimeout,
  }
}

// Milliseconds until the policy acts; a policy that waits never does
export const timeoutMs = (policy: Ask['policy']): number | null =>
  policy.onTimeout === 'wait' ? null : parseDuration(policy.timeout)

// Everything that can throw happens here, before the ask is stored or announced
export const buildAsk = (input: OpenAskInput): Ask => {
  const policy = policyFor(input)
  const createdAt = nowIso()
  const delay = timeoutMs(policy)
  return {
    id: uuidv7(),
    sessionId: input.sessionId,
    turnId: input.turnId,
    kind: input.kind,
    title: input.title,
    ...questionsOf(input),
    ...(input.toolCall === undefined ? {} : { toolCall: input.toolCall }),
    policy,
    status: 'pending',
    createdAt,
    deadlineAt: delay === null ? null : new Date(Date.parse(createdAt) + delay).toISOString(),
  }
}

// One id per question, in order; a question without a recommended option contributes an empty id
export const recommendedAnswer = (ask: Ask): AskAnswer => ({
  selected: ask.questions.map((question) => {
    const pick = question.options.find((option) => option.recommended)
    return pick === undefined ? '' : pick.id
  }),
})

// What the kernel answers when nobody did: a permission is denied with a reason, a question takes the recommendation
export const timeoutAnswer = (ask: Ask): AskAnswer =>
  ask.policy.onTimeout === 'deny'
    ? { selected: ['deny'], otherText: DENY_ON_TIMEOUT_MESSAGE }
    : recommendedAnswer(ask)
