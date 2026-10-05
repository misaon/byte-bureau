import type {
  SDKAssistantMessage,
  SDKAuthStatusMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, ToolKind } from '@bytebureau/protocol'
import { contextPctOf, mapRateLimit, mapResult, type MapState } from './mapping-result.js'

export { newMapState, unreadResult, type MapState } from './mapping-result.js'

type Block = SDKAssistantMessage['message']['content'][number]
type Delta = Extract<SDKPartialAssistantMessage['event'], { type: 'content_block_delta' }>['delta']
type UserBlock = Exclude<SDKUserMessage['message']['content'], string>[number]
type ToolResult = Extract<UserBlock, { type: 'tool_result' }>
type SystemMessage = Extract<SDKMessage, { type: 'system' }>
type RetryMessage = Extract<SystemMessage, { subtype: 'api_retry' }>

const SUMMARY_LIMIT = 32 * 1024
// The errors of an assistant message that say the login is gone; the CLI sends them instead of an auth_status
const AUTH_ERRORS: ReadonlySet<string> = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'cloud_credential_error',
])

export const toolKindOf = (name: string): ToolKind => {
  if (name === 'Bash') {
    return 'bash'
  }
  if (name === 'Task') {
    return 'subagent'
  }
  if (name === 'Skill') {
    return 'skill'
  }
  return name.startsWith('mcp__') ? 'mcp' : 'builtin'
}

// The plain text of content: its text blocks joined, anything else left out
const textOf = (content: string | readonly { readonly type: string }[] | undefined): string => {
  if (content === undefined || typeof content === 'string') {
    return content ?? ''
  }
  return content
    .map((block) =>
      block.type === 'text' && 'text' in block && typeof block.text === 'string' ? block.text : '',
    )
    .join('')
}

// The first event of a turn announces it; the result lets the next turn announce itself again
const started = (state: MapState): readonly AgentEvent[] => {
  if (state.turnStarted) {
    return []
  }
  state.turnStarted = true
  return [{ type: 'turn.started' }]
}

const deltaOf = (delta: Delta): readonly AgentEvent[] => {
  if (delta.type === 'text_delta') {
    return [{ type: 'message.delta', kind: 'text', text: delta.text }]
  }
  if (delta.type === 'thinking_delta') {
    return [{ type: 'message.delta', kind: 'thinking', text: delta.thinking }]
  }
  return []
}

const mapStream = (message: SDKPartialAssistantMessage, state: MapState): readonly AgentEvent[] => {
  const { event } = message
  return [...started(state), ...(event.type === 'content_block_delta' ? deltaOf(event.delta) : [])]
}

const toolStarted = (block: Block): readonly AgentEvent[] =>
  block.type === 'tool_use'
    ? [
        {
          type: 'tool.started',
          id: block.id,
          name: block.name,
          kind: toolKindOf(block.name),
          input: block.input,
        },
      ]
    : []

// A lost login comes as an assistant message with an error; the session cannot go on, so it is an error of the session
const mapAssistant = (message: SDKAssistantMessage, state: MapState): readonly AgentEvent[] => {
  if (message.context_usage !== undefined) {
    state.contextPct = contextPctOf(message.context_usage)
  }
  const { content } = message.message
  const text = textOf(content)
  if (message.error !== undefined && AUTH_ERRORS.has(message.error)) {
    const reason = text === '' ? message.error : text
    return [
      ...started(state),
      { type: 'session.error', kind: 'auth', message: reason, retryable: false },
    ]
  }
  return [
    ...started(state),
    { type: 'message.completed', role: 'assistant', content: [...content], text },
    ...content.flatMap((block) => toolStarted(block)),
  ]
}

const toolEnded = (block: ToolResult): AgentEvent => {
  const text = textOf(block.content)
  return block.is_error === true
    ? { type: 'tool.failed', id: block.tool_use_id, error: text.slice(0, SUMMARY_LIMIT) }
    : {
        type: 'tool.completed',
        id: block.tool_use_id,
        outputSummary: text.slice(0, SUMMARY_LIMIT),
        bytes: Buffer.byteLength(text),
      }
}

const mapToolResults = (content: SDKUserMessage['message']['content']): readonly AgentEvent[] =>
  typeof content === 'string'
    ? []
    : content.flatMap((block) => (block.type === 'tool_result' ? [toolEnded(block)] : []))

const retryWarning = (message: RetryMessage): AgentEvent => {
  const status = message.error_status === null ? '' : ` (${message.error_status})`
  const attempt = `attempt ${message.attempt} of ${message.max_retries} in ${message.retry_delay_ms} ms`
  return {
    type: 'session.warning',
    kind: 'api_retry',
    message: `${attempt}: ${message.error}${status}`,
  }
}

const mapSystem = (message: SystemMessage, state: MapState): readonly AgentEvent[] => {
  if (message.subtype === 'init') {
    state.sessionId = message.session_id
    return []
  }
  if (message.subtype === 'compact_boundary') {
    return [{ type: 'compaction.completed' }]
  }
  return message.subtype === 'api_retry' ? [retryWarning(message)] : []
}

const authErrorOf = (message: SDKAuthStatusMessage): readonly AgentEvent[] =>
  message.error === undefined
    ? []
    : [{ type: 'session.error', kind: 'auth', message: message.error, retryable: false }]

type Handlers = {
  readonly [Type in SDKMessage['type']]?: (
    message: Extract<SDKMessage, { readonly type: Type }>,
    state: MapState,
  ) => readonly AgentEvent[]
}

// The messages ByteBureau shows, by their type; any other maps to nothing
const HANDLERS: Handlers = {
  system: mapSystem,
  stream_event: mapStream,
  assistant: mapAssistant,
  user: (message) => mapToolResults(message.message.content),
  result: mapResult,
  rate_limit_event: (message, state) => mapRateLimit(message.rate_limit_info, state),
  auth_status: authErrorOf,
}

// The lookup is generic in the type, which is what lets the compiler pair a message with its handler
const run = <Type extends SDKMessage['type']>(
  type: Type,
  message: Extract<SDKMessage, { readonly type: Type }>,
  state: MapState,
): readonly AgentEvent[] => {
  const handler = HANDLERS[type]
  return handler === undefined ? [] : handler(message, state)
}

// A Task subagent's own messages are left out until a later phase shows subagents; the Task's result tells what it did
const ofSubagent = (message: SDKMessage): boolean =>
  'parent_tool_use_id' in message && message.parent_tool_use_id !== null

// The canonical events of one message of the SDK
export const mapMessage = (message: SDKMessage, state: MapState): readonly AgentEvent[] =>
  ofSubagent(message) ? [] : run(message.type, message, state)
