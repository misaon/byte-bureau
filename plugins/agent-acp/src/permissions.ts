import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk'
import type { AgentEvent, Ask, AskAnswer, AskOption } from '@bytebureau/protocol'

// A request the agent waits on: the options it offered, and how its answer is given
interface Pending {
  readonly options: readonly PermissionOption[]
  readonly resolve: (response: RequestPermissionResponse) => void
}

const CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }
const ALLOWING: readonly PermissionOptionKind[] = ['allow_once', 'allow_always']
const REJECTING: readonly PermissionOptionKind[] = ['reject_once', 'reject_always']

const optionOf = ({ optionId, name }: PermissionOption): AskOption => ({
  id: optionId,
  label: name,
  recommended: false,
  evidence: [],
})

// One question whose options are the agent's, about the tool call it names; the kernel sets the turn, the policy and the deadline it keeps
const askOf = (sessionId: string, { toolCall, options }: RequestPermissionRequest): Ask => {
  const title = toolCall.title ?? toolCall.toolCallId
  return {
    id: toolCall.toolCallId,
    sessionId,
    turnId: null,
    kind: 'permission',
    title,
    questions: [
      {
        id: 'decision',
        header: 'Permission',
        prompt: `Allow ${title}?`,
        options: options.map((option) => optionOf(option)),
        multiSelect: false,
        allowOther: false,
      },
    ],
    toolCall: { name: title, input: toolCall.rawInput ?? null },
    policy: { onTimeout: 'wait', timeout: '30m' },
    recommendationSource: 'none',
    status: 'pending',
    createdAt: new Date().toISOString(),
    deadlineAt: null,
  }
}

const firstOf = (
  options: readonly PermissionOption[],
  kinds: readonly PermissionOptionKind[],
): PermissionOption | undefined =>
  kinds
    .map((kind) => options.find((option) => option.kind === kind))
    .find((option) => option !== undefined)

// The kernel asks a permission with an allow and a deny of its own: they go by the kinds of the agent's options, never by their names
// Another id names an option of the agent; anything that does not allow declines
const chosenOf = (
  options: readonly PermissionOption[],
  answer: AskAnswer,
): PermissionOption | undefined => {
  const [id] = answer.selected === 'other' ? ['deny'] : answer.selected
  if (id === 'allow') {
    return firstOf(options, ALLOWING)
  }
  const named = id === 'deny' ? undefined : options.find((option) => option.optionId === id)
  return named ?? firstOf(options, REJECTING)
}

// An allow the answer asks to remember always is the agent's allow-always, when it offered one; an answer the agent has no option for cancels
const responseOf = (
  options: readonly PermissionOption[],
  answer: AskAnswer,
): RequestPermissionResponse => {
  const chosen = chosenOf(options, answer)
  if (chosen === undefined) {
    return CANCELLED
  }
  const always = answer.remember === 'always' && chosen.kind === 'allow_once'
  const option = always ? (firstOf(options, ['allow_always']) ?? chosen) : chosen
  return { outcome: { outcome: 'selected', optionId: option.optionId } }
}

// The permission requests of one session: each is told as an ask, by the id of its tool call, and waits for the answer
export class PermissionBroker {
  private readonly pending = new Map<string, Pending>()
  private readonly sessionId: string
  private readonly tell: (event: AgentEvent) => void
  // Whether the turn is interrupted: its requests are answered cancelled at once, as ACP has it
  private readonly interrupted: () => boolean

  public constructor(
    sessionId: string,
    tell: (event: AgentEvent) => void,
    interrupted: () => boolean = (): boolean => false,
  ) {
    this.sessionId = sessionId
    this.tell = tell
    this.interrupted = interrupted
  }

  // A request the agent took back before it was asked is not asked; a new request for a tool call replaces the one before
  public async request(
    params: RequestPermissionRequest,
    signal?: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    if (this.interrupted() || (signal !== undefined && signal.aborted)) {
      return CANCELLED
    }
    const ask = askOf(this.sessionId, params)
    this.settle(ask.id, CANCELLED)
    const answered = this.waitFor(ask.id, params.options, signal)
    this.tell({ type: 'ask.requested', ask })
    const response = await answered
    return response
  }

  // An answer to an ask that is no longer pending is too late, and changes nothing
  public answer(askId: string, answer: AskAnswer): void {
    const pending = this.pending.get(askId)
    if (pending !== undefined) {
      this.settle(askId, responseOf(pending.options, answer))
    }
  }

  public cancelAll(): void {
    for (const pending of this.pending.values()) {
      pending.resolve(CANCELLED)
    }
    this.pending.clear()
  }

  // The request is pending before it is told, so an answer given as it is told finds it
  private async waitFor(
    askId: string,
    options: readonly PermissionOption[],
    signal: AbortSignal | undefined,
  ): Promise<RequestPermissionResponse> {
    const { promise, resolve } = Promise.withResolvers<RequestPermissionResponse>()
    const pending: Pending = { options, resolve }
    this.pending.set(askId, pending)
    this.cancelOn(askId, pending, signal)
    const response = await promise
    return response
  }

  // The agent takes a request back with $/cancel_request, or by going; only that request is cancelled
  private cancelOn(askId: string, pending: Pending, signal: AbortSignal | undefined): void {
    if (signal !== undefined) {
      const cancel = (): void => {
        if (this.pending.get(askId) === pending) {
          this.settle(askId, CANCELLED)
        }
      }
      signal.addEventListener('abort', cancel, { once: true })
    }
  }

  private settle(askId: string, response: RequestPermissionResponse): void {
    const pending = this.pending.get(askId)
    if (pending !== undefined) {
      this.pending.delete(askId)
      pending.resolve(response)
    }
  }
}
