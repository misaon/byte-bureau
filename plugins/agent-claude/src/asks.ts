import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, Ask, AskAnswer, AskOption, AskQuestion } from '@bytebureau/protocol'
import { answersOf, questionsOf, recommendationOf } from './ask-questions.js'

// The ids the SDK gives a permission prompt; the request id is the id of the ask, so the kernel's answer finds it
export interface AskIds {
  readonly requestId: string
  readonly toolUseID: string
}

type Input = Record<string, unknown>

// A prompt the SDK waits on, and how an answer of the kernel becomes the result the SDK takes
interface Pending {
  readonly resolve: (result: PermissionResult) => void
  readonly resultOf: (answer: AskAnswer) => PermissionResult
}

const DENIED = 'denied through ByteBureau'

// What every ask of the adapter shares; the kernel sets the turn, the policy and the deadline it keeps
const commonOf = (
  sessionId: string,
  requestId: string,
): Omit<Ask, 'kind' | 'title' | 'questions' | 'recommendationSource'> => ({
  id: requestId,
  sessionId,
  turnId: null,
  policy: { onTimeout: 'wait', timeout: '30m' },
  status: 'pending',
  createdAt: new Date().toISOString(),
  deadlineAt: null,
})

const choice = (id: 'allow' | 'deny', label: string): AskOption => ({
  id,
  label,
  recommended: false,
  evidence: [],
})

const permissionQuestion = (toolName: string): AskQuestion => ({
  id: 'decision',
  header: 'Permission',
  prompt: `Allow ${toolName}?`,
  options: [choice('allow', 'Allow'), choice('deny', 'Deny')],
  multiSelect: false,
  allowOther: false,
})

// Allowed only by an explicit allow; a denial passes on the reason the answer gives, when it gives one
const decided =
  (input: Input) =>
  (answer: AskAnswer): PermissionResult =>
    answer.selected !== 'other' && answer.selected[0] === 'allow'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: answer.otherText ?? DENIED }

const answered =
  (input: Input, questions: readonly AskQuestion[]) =>
  (answer: AskAnswer): PermissionResult => ({
    behavior: 'allow',
    updatedInput: { ...input, answers: answersOf(questions, answer) },
  })

// The permission prompts of one session: each becomes an ask the kernel opens, and waits for its answer
export class AskBroker {
  private readonly pending = new Map<string, Pending>()
  private readonly sessionId: string
  private queued: AgentEvent[] = []

  public constructor(sessionId = '') {
    this.sessionId = sessionId
  }

  // AskUserQuestion is a question to the person; any other tool, or a question that cannot be read, asks for a permission
  public async ask(toolName: string, input: Input, ids: AskIds): Promise<PermissionResult> {
    const { promise, resolve } = Promise.withResolvers<PermissionResult>()
    const questions = toolName === 'AskUserQuestion' ? questionsOf(input) : []
    const common = commonOf(this.sessionId, ids.requestId)
    const [first] = questions
    const ask: Ask =
      first === undefined
        ? {
            ...common,
            kind: 'permission',
            title: toolName,
            questions: [permissionQuestion(toolName)],
            toolCall: { name: toolName, input },
            recommendationSource: 'none',
          }
        : {
            ...common,
            kind: 'question',
            title: first.prompt,
            questions,
            recommendationSource: recommendationOf(questions),
          }
    this.pending.set(ids.requestId, {
      resolve,
      resultOf: first === undefined ? decided(input) : answered(input, questions),
    })
    this.queued.push({ type: 'ask.requested', ask })
    const result = await promise
    return result
  }

  // An answer to an ask that is no longer pending is too late, and changes nothing
  public answer(askId: string, answer: AskAnswer): void {
    const pending = this.pending.get(askId)
    if (pending !== undefined) {
      this.pending.delete(askId)
      pending.resolve(pending.resultOf(answer))
    }
  }

  public denyAll(message: string): void {
    for (const pending of this.pending.values()) {
      pending.resolve({ behavior: 'deny', message })
    }
    this.pending.clear()
  }

  // The asks raised since the last drain, for the session to tell
  public drain(): readonly AgentEvent[] {
    const drained = this.queued
    this.queued = []
    return drained
  }
}
