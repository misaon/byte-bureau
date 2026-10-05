import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, Ask, AskAnswer, AskOption, AskQuestion } from '@bytebureau/protocol'
import { answersOf, questionsOf, recommendationOf } from './ask-questions.js'

// The ids the SDK gives a permission prompt; the request id is the id of the ask, so the kernel's answer finds it
export interface AskIds {
  readonly requestId: string
  readonly toolUseID: string
  // Aborted when the SDK takes the prompt back, as when the CLI cancels it
  readonly signal?: AbortSignal | undefined
}

type Input = Record<string, unknown>

// A prompt the SDK waits on, and how an answer of the kernel becomes the result the SDK takes
interface Pending {
  readonly resolve: (result: PermissionResult) => void
  readonly resultOf: (answer: AskAnswer) => PermissionResult
}

const DENIED = 'denied through ByteBureau'

type Common = Omit<Ask, 'kind' | 'title' | 'questions' | 'recommendationSource'>

// What every ask of the adapter shares; the kernel sets the turn, the policy and the deadline it keeps
const commonOf = (sessionId: string, requestId: string): Common => ({
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

const cancelled = (): PermissionResult => ({ behavior: 'deny', message: 'cancelled' })

// The ask a prompt raises, and how an answer of the kernel becomes the result the SDK takes
interface Raised {
  readonly ask: Ask
  readonly resultOf: (answer: AskAnswer) => PermissionResult
}

// AskUserQuestion is a question to the person; any other tool, or a question that cannot be read, asks for a permission
const raisedOf = (toolName: string, input: Input, common: Common): Raised => {
  const questions = toolName === 'AskUserQuestion' ? questionsOf(input) : []
  const [first] = questions
  if (first === undefined) {
    const question = permissionQuestion(toolName)
    const toolCall = { name: toolName, input }
    return {
      ask: {
        ...common,
        kind: 'permission',
        title: toolName,
        questions: [question],
        toolCall,
        recommendationSource: 'none',
      },
      resultOf: decided(input),
    }
  }
  const recommendationSource = recommendationOf(questions)
  return {
    ask: { ...common, kind: 'question', title: first.prompt, questions, recommendationSource },
    resultOf: answered(input, questions),
  }
}

// The permission prompts of one session: each becomes an ask the kernel opens, and waits for its answer
export class AskBroker {
  private readonly pending = new Map<string, Pending>()
  private readonly sessionId: string
  private queued: AgentEvent[] = []

  public constructor(sessionId = '') {
    this.sessionId = sessionId
  }

  // A prompt the SDK took back before it was raised is not asked at all
  public async ask(toolName: string, input: Input, ids: AskIds): Promise<PermissionResult> {
    if (ids.signal !== undefined && ids.signal.aborted) {
      return cancelled()
    }
    const { promise, resolve } = Promise.withResolvers<PermissionResult>()
    const raised = raisedOf(toolName, input, commonOf(this.sessionId, ids.requestId))
    this.pending.set(ids.requestId, { resolve, resultOf: raised.resultOf })
    this.queued.push({ type: 'ask.requested', ask: raised.ask })
    this.cancelOn(ids)
    const result = await promise
    return result
  }

  // An answer to an ask that is no longer pending is too late, and changes nothing
  public answer(askId: string, answer: AskAnswer): void {
    const pending = this.pending.get(askId)
    if (pending !== undefined) {
      this.settle(askId, pending.resultOf(answer))
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

  // The SDK takes a prompt back when the CLI cancels it; its ask is then settled as denied
  private cancelOn({ requestId, signal }: AskIds): void {
    if (signal !== undefined) {
      const cancel = (): void => {
        this.settle(requestId, cancelled())
      }
      signal.addEventListener('abort', cancel, { once: true })
    }
  }

  private settle(askId: string, result: PermissionResult): void {
    const pending = this.pending.get(askId)
    if (pending !== undefined) {
      this.pending.delete(askId)
      pending.resolve(result)
    }
  }
}
