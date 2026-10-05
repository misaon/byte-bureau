import type {
  ContentBlock,
  SessionUpdate,
  ToolCallContent,
  ToolCallStatus,
  ToolKind as AcpToolKind,
} from '@agentclientprotocol/sdk'
import type { AgentEvent, ToolKind } from '@bytebureau/protocol'
import { z } from 'zod'

type Update<Kind extends SessionUpdate['sessionUpdate']> = Extract<
  SessionUpdate,
  { readonly sessionUpdate: Kind }
>

const SUMMARY_LIMIT = 32 * 1024

// The bytebureau extensions of _meta: an agent that knows ByteBureau may report usage and rate limits on any update
const UsageMeta = z.object({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheReadTokens: z.exactOptional(z.int().nonnegative()),
  cacheWriteTokens: z.exactOptional(z.int().nonnegative()),
  costUsd: z.exactOptional(z.number()),
  contextPct: z.exactOptional(z.number()),
})
const RateLimitMeta = z.object({
  fiveHourPct: z.exactOptional(z.number()),
  fiveHourResetsAt: z.exactOptional(z.string()),
  sevenDayPct: z.exactOptional(z.number()),
  sevenDayResetsAt: z.exactOptional(z.string()),
})

// A command is bash; every other kind of ACP tool is a builtin of the agent
const kindOf = (kind: AcpToolKind | null | undefined): ToolKind =>
  kind === 'execute' ? 'bash' : 'builtin'

const deltaOf = (kind: 'text' | 'thinking', content: ContentBlock): readonly AgentEvent[] =>
  content.type === 'text' ? [{ type: 'message.delta', kind, text: content.text }] : []

const rawTextOf = (raw: unknown): string => {
  if (raw === undefined || raw === null) {
    return ''
  }
  return typeof raw === 'string' ? raw : JSON.stringify(raw)
}

// The text of what a tool produced: its text content, else its raw output
const outputOf = (
  content: readonly ToolCallContent[] | null | undefined,
  rawOutput: unknown,
): string => {
  const text = (content ?? [])
    .map((item) =>
      item.type === 'content' && item.content.type === 'text' ? item.content.text : '',
    )
    .join('')
  return text === '' ? rawTextOf(rawOutput) : text
}

const endedOf = (
  id: string,
  status: ToolCallStatus | null | undefined,
  output: string,
): readonly AgentEvent[] => {
  if (status === 'completed') {
    const outputSummary = output.slice(0, SUMMARY_LIMIT)
    return [{ type: 'tool.completed', id, outputSummary, bytes: Buffer.byteLength(output) }]
  }
  return status === 'failed'
    ? [{ type: 'tool.failed', id, error: output.slice(0, SUMMARY_LIMIT) }]
    : []
}

// A tool call may come over already ended
const toolCallOf = (update: Update<'tool_call'>): readonly AgentEvent[] => [
  {
    type: 'tool.started',
    id: update.toolCallId,
    name: update.title,
    kind: kindOf(update.kind),
    input: update.rawInput ?? null,
  },
  ...endedOf(update.toolCallId, update.status, outputOf(update.content, update.rawOutput)),
]

type Handlers = {
  readonly [Kind in SessionUpdate['sessionUpdate']]?: (
    update: Update<Kind>,
  ) => readonly AgentEvent[]
}

// The updates ByteBureau shows, by their kind; any other maps to nothing
const HANDLERS: Handlers = {
  agent_message_chunk: (update) => deltaOf('text', update.content),
  agent_thought_chunk: (update) => deltaOf('thinking', update.content),
  tool_call: toolCallOf,
  tool_call_update: (update) =>
    endedOf(update.toolCallId, update.status, outputOf(update.content, update.rawOutput)),
  plan: (update) => [
    { type: 'session.warning', kind: 'plan', message: JSON.stringify(update.entries) },
  ],
}

// The lookup is generic in the kind, which is what lets the compiler pair an update with its handler
const run = <Kind extends SessionUpdate['sessionUpdate']>(
  kind: Kind,
  update: Update<Kind>,
): readonly AgentEvent[] => {
  const handler = HANDLERS[kind]
  return handler === undefined ? [] : handler(update)
}

// A rate limit that names no window tells nothing
const metaEventsOf = (
  meta: Readonly<Record<string, unknown>> | null | undefined,
): readonly AgentEvent[] => {
  if (meta === null || meta === undefined) {
    return []
  }
  const usage = UsageMeta.safeParse(meta['bytebureau.usage'])
  const rateLimit = RateLimitMeta.safeParse(meta['bytebureau.rateLimit'])
  const windows = rateLimit.success ? Object.keys(rateLimit.data).length : 0
  return [
    ...(usage.success ? [{ type: 'usage.updated', usage: usage.data } as const] : []),
    ...(rateLimit.success && windows > 0
      ? [{ type: 'ratelimit.updated', rateLimit: rateLimit.data } as const]
      : []),
  ]
}

// The canonical events of one update of the agent, what its _meta carries after what the update itself tells
export const mapUpdate = (update: SessionUpdate): readonly AgentEvent[] => {
  const { _meta: meta } = update
  return [...run(update.sessionUpdate, update), ...metaEventsOf(meta)]
}
