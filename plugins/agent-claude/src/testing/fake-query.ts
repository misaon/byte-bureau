import type {
  AccountInfo,
  HookInput,
  Options,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { AgentQuery, QueryFn } from '../deps.js'

// A permission prompt the agent raises in the middle of a turn, as the SDK calls canUseTool
interface AskStep {
  readonly ask: {
    readonly toolName: string
    readonly input: Record<string, unknown>
    readonly requestId: string
  }
}

// A hook the agent runs in the middle of a turn
export interface HookStep {
  readonly hook: HookInput
}

// The query fails, as when the CLI dies
interface FailStep {
  readonly fail: Error
}

type Step = SDKMessage | AskStep | HookStep | FailStep

export interface FakeScript {
  // What the agent does for each prompt, the first list for the first prompt
  readonly turns?: readonly (readonly Step[])[]
  readonly account?: AccountInfo
  readonly initFailure?: Error
  // When set, initializationResult never answers
  readonly hangs?: boolean
  // When set, query() throws it at once, as the SDK does when it finds no Claude Code to run
  readonly throws?: Error
}

// What the adapter did with the query: every query's options, the prompts, what canUseTool answered, the calls
export interface FakeQuery {
  readonly query: QueryFn
  readonly options: Options[]
  readonly prompts: SDKUserMessage[]
  readonly permissions: (PermissionResult | null)[]
  readonly models: string[]
  readonly calls: { interrupt: number; close: number }
}

interface Run {
  readonly options: Options
  readonly script: FakeScript
  readonly fake: FakeQuery
  closed: boolean
}

const askOf = async ({ ask }: AskStep, { options, fake }: Run): Promise<void> => {
  if (options.canUseTool === undefined) {
    throw new Error('the adapter gave the query no canUseTool')
  }
  const ids = { signal: new AbortController().signal, toolUseID: `toolu-${ask.requestId}` }
  fake.permissions.push(
    await options.canUseTool(ask.toolName, ask.input, { ...ids, requestId: ask.requestId }),
  )
}

const hookOf = async ({ hook }: HookStep, { options }: Run): Promise<void> => {
  const matchers = options.hooks === undefined ? undefined : options.hooks[hook.hook_event_name]
  const hooks = (matchers ?? []).flatMap((matcher) => matcher.hooks)
  const { signal } = new AbortController()
  await Promise.all(
    hooks.map(async (run) => {
      await run(hook, undefined, { signal })
    }),
  )
}

// The message a step yields; an ask or a hook is played and yields nothing
const play = async (step: Step, run: Run): Promise<SDKMessage | undefined> => {
  if ('ask' in step) {
    await askOf(step, run)
    return undefined
  }
  if ('hook' in step) {
    await hookOf(step, run)
    return undefined
  }
  if ('fail' in step) {
    throw step.fail
  }
  return step
}

// The steps of one turn played in order; an async generator awaits what it yields
async function* playSteps(
  steps: readonly Step[],
  run: Run,
): AsyncGenerator<SDKMessage | undefined> {
  for (const step of steps) {
    yield play(step, run)
  }
}

// One turn per user message the adapter pushes, until the input ends or the query is closed
async function* playTurns(
  prompt: AsyncIterable<SDKUserMessage>,
  run: Run,
): AsyncGenerator<SDKMessage> {
  let turn = 0
  for await (const message of prompt) {
    run.fake.prompts.push(message)
    for await (const yielded of playSteps((run.script.turns ?? [])[turn] ?? [], run)) {
      if (run.closed) {
        return
      }
      if (yielded !== undefined) {
        yield yielded
      }
    }
    turn += 1
  }
}

const initializationOf = async (run: Run): ReturnType<AgentQuery['initializationResult']> => {
  if (run.script.hangs === true) {
    await Promise.withResolvers<never>().promise
  }
  if (run.script.initFailure !== undefined) {
    throw run.script.initFailure
  }
  const account = await Promise.resolve(run.script.account ?? {})
  return {
    commands: [],
    agents: [],
    output_style: 'default',
    available_output_styles: [],
    models: [],
    account,
  }
}

const queryOf = (prompt: AsyncIterable<SDKUserMessage>, run: Run): AgentQuery => {
  const turns = playTurns(prompt, run)
  return {
    [Symbol.asyncIterator]: () => turns,
    interrupt: async () => {
      run.fake.calls.interrupt += 1
      const receipt = await Promise.resolve({ still_queued: [] })
      return receipt
    },
    close: () => {
      run.fake.calls.close += 1
      run.closed = true
    },
    setModel: async (model) => {
      await Promise.resolve()
      run.fake.models.push(model ?? 'default')
    },
    initializationResult: async () => {
      const result = await initializationOf(run)
      return result
    },
    accountInfo: async () => {
      const { account } = await initializationOf(run)
      return account
    },
  }
}

// A query() that plays a script instead of running Claude Code, and records what the adapter asked of it
export const fakeQuery = (script: FakeScript = {}): FakeQuery => {
  const fake: FakeQuery = {
    query: ({ prompt, options }) => {
      fake.options.push(options)
      if (script.throws !== undefined) {
        throw script.throws
      }
      return queryOf(prompt, { options, script, fake, closed: false })
    },
    options: [],
    prompts: [],
    permissions: [],
    models: [],
    calls: { interrupt: 0, close: 0 },
  }
  return fake
}

// The input of a hook the SDK calls when a subagent starts or stops
export const subagentHook = (
  event: 'SubagentStart' | 'SubagentStop',
  agentId: string,
  agentType: string,
): HookStep => {
  const base = {
    session_id: 'session-0001',
    transcript_path: '/t.jsonl',
    cwd: '/w',
    agent_id: agentId,
    agent_type: agentType,
  }
  return {
    hook:
      event === 'SubagentStart'
        ? { ...base, hook_event_name: 'SubagentStart' }
        : {
            ...base,
            hook_event_name: 'SubagentStop',
            stop_hook_active: false,
            agent_transcript_path: '/a.jsonl',
          },
  }
}
