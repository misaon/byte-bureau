import type { Ask, AskAnswer, AskOption, AskQuestion, PermissionMode } from '@bytebureau/protocol'
import { nowIso, uuidv7 } from '../ids.js'
import {
  NO_RECOMMENDATION,
  parseDuration,
  recommendForPermission,
  type ToolCall,
} from './policy.js'

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

// A permission is always allow or deny; the rules recommend one of them for a tool call, or neither, and without a tool call there is nothing to judge
const permissionQuestions = (input: OpenAskInput): Questions => {
  const { toolCall } = input
  const { recommended, ruleId } =
    toolCall === undefined
      ? NO_RECOMMENDATION
      : recommendForPermission(toolCall, input.workspacePath, input.permissionMode)
  const option = (id: 'allow' | 'deny', label: string): AskOption => ({
    id,
    label,
    recommended: recommended === id,
    evidence: recommended === id && ruleId !== null ? [{ kind: 'rule', ref: ruleId }] : [],
  })
  const question: AskQuestion = {
    id: 'permission',
    header: 'Permission',
    prompt: toolCall === undefined ? 'Allow this?' : `${toolCall.name}: allow this tool call?`,
    options: [option('allow', 'Allow'), option('deny', 'Deny')],
    multiSelect: false,
    allowOther: false,
  }
  return { questions: [question], recommendationSource: recommended === null ? 'none' : 'policy' }
}

const recommendedCount = (question: AskQuestion): number =>
  question.options.filter((option) => option.recommended).length

// A recommendation is one recommended option in every question; a question with none or with two has no answer to take
export const unrecommendedQuestions = (ask: Ask): readonly string[] =>
  ask.questions
    .filter((question) => recommendedCount(question) !== 1)
    .map((question) => question.id)

const hasRecommendation = (questions: readonly AskQuestion[]): boolean =>
  questions.length > 0 && questions.every((question) => recommendedCount(question) === 1)

// A permission always gets the questions the rules derive; any other ask keeps the ones it came with
const questionsOf = (input: OpenAskInput): Questions => {
  if (input.kind === 'permission') {
    return permissionQuestions(input)
  }
  const source = hasRecommendation(input.questions)
    ? (input.recommendationSource ?? 'agent')
    : 'none'
  return { questions: input.questions, recommendationSource: source }
}

// Supervised employees are waited for; so is a question nobody recommended an answer to, the kernel makes none up
// The other asks get the fallback of their kind once the timeout is over: a question its recommendation, a permission a denial
const policyFor = (input: OpenAskInput, source: Ask['recommendationSource']): Ask['policy'] => {
  const timeout = input.askTimeout
  if (input.permissionMode === 'supervised') {
    return { onTimeout: 'wait', timeout }
  }
  if (input.kind === 'permission') {
    return { onTimeout: 'deny', timeout }
  }
  return { onTimeout: source === 'none' ? 'wait' : 'recommended', timeout }
}

// Milliseconds until the policy acts; a policy that waits never does
export const timeoutMs = (policy: Ask['policy']): number | null =>
  policy.onTimeout === 'wait' ? null : parseDuration(policy.timeout)

// Everything that can throw happens here, before the ask is stored or announced
export const buildAsk = (input: OpenAskInput): Ask => {
  const { questions, recommendationSource } = questionsOf(input)
  const policy = policyFor(input, recommendationSource)
  const createdAt = nowIso()
  const delay = timeoutMs(policy)
  return {
    id: uuidv7(),
    sessionId: input.sessionId,
    turnId: input.turnId,
    kind: input.kind,
    title: input.title,
    questions,
    recommendationSource,
    ...(input.toolCall === undefined ? {} : { toolCall: input.toolCall }),
    policy,
    status: 'pending',
    createdAt,
    deadlineAt: delay === null ? null : new Date(Date.parse(createdAt) + delay).toISOString(),
  }
}

// Only an ask in which every question has a recommended option is ever answered this way
const recommendedId = (question: AskQuestion): string => {
  const pick = question.options.find((option) => option.recommended)
  if (pick === undefined) {
    throw new Error(`question ${question.id} has no recommended option`)
  }
  return pick.id
}

// One id per question, in order
export const recommendedAnswer = (ask: Ask): AskAnswer => ({
  selected: ask.questions.map((question) => recommendedId(question)),
})

// What the kernel answers when nobody did: a permission is denied with a reason, a question takes the recommendation
export const timeoutAnswer = (ask: Ask): AskAnswer =>
  ask.policy.onTimeout === 'deny'
    ? { selected: ['deny'], otherText: DENY_ON_TIMEOUT_MESSAGE }
    : recommendedAnswer(ask)
