import type { UUID } from 'node:crypto'
import type {
  ModelUsage,
  NonNullableUsage,
  SDKAssistantMessage,
  SDKAuthStatusMessage,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKRateLimitEvent,
  SDKResultError,
  SDKResultSuccess,
  SDKSystemMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'

// Recorded shapes of the Agent SDK's messages, checked by the compiler against the installed declarations
// The init, the failed login and the error result follow what the real SDK sent in the probe of Task 6

export const SESSION = 'session-0001'
const MODEL = 'claude-opus-5-5'

const uuid = (serial: number): UUID => `00000000-0000-7000-8000-${String(serial).padStart(12, '0')}`

// The usage of a result: every field present, as the probe saw it
const resultUsage = (input: number, output: number): NonNullableUsage => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: 'standard',
  inference_geo: '',
  iterations: [],
  speed: 'standard',
  output_tokens_details: { thinking_tokens: 0 },
  fallback_credit: null,
})

// The running totals of one model, as a result reports them
export const modelUsage = (
  input: number,
  output: number,
  costUSD: number,
): Readonly<Record<string, ModelUsage>> => ({
  [MODEL]: {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: 2,
    cacheCreationInputTokens: 1,
    webSearchRequests: 0,
    costUSD,
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
  },
})

export const init: SDKSystemMessage = {
  type: 'system',
  subtype: 'init',
  apiKeySource: 'none',
  claude_code_version: '2.1.285',
  cwd: '/w',
  tools: ['Task', 'AskUserQuestion', 'Bash', 'Edit', 'Read', 'Skill', 'Write'],
  mcp_servers: [],
  model: MODEL,
  permissionMode: 'default',
  slash_commands: [],
  output_style: 'default',
  skills: [],
  plugins: [],
  session_id: SESSION,
  uuid: uuid(1),
}

const delta = (
  event: SDKPartialAssistantMessage['event'],
  serial: number,
): SDKPartialAssistantMessage => ({
  type: 'stream_event',
  event,
  parent_tool_use_id: null,
  session_id: SESSION,
  uuid: uuid(serial),
})

export const textDelta = delta(
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
  2,
)
export const thinkingDelta = delta(
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'hm', estimated_tokens: null },
  },
  3,
)

const assistant = (
  content: SDKAssistantMessage['message']['content'],
  serial: number,
): SDKAssistantMessage => ({
  type: 'assistant',
  message: {
    id: 'msg_1',
    container: null,
    content,
    context_management: null,
    diagnostics: null,
    model: MODEL,
    role: 'assistant',
    stop_details: null,
    stop_reason: null,
    stop_sequence: null,
    type: 'message',
    usage: resultUsage(10, 5),
  },
  parent_tool_use_id: null,
  session_id: SESSION,
  uuid: uuid(serial),
})

export const assistantWithTool = assistant(
  [
    { type: 'text', text: 'Editing.', citations: null },
    { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: '/w/src/hello.ts' } },
  ],
  4,
)

const toolResultOf = (content: string, isError: boolean, serial: number): SDKUserMessage => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content, is_error: isError }],
  },
  parent_tool_use_id: null,
  session_id: SESSION,
  uuid: uuid(serial),
})

export const toolResult = toolResultOf('ok', false, 5)
export const toolFailed = toolResultOf('permission denied', true, 11)

// What every result of the fixtures shares: one model's running totals, nothing denied
const resultCommon = {
  duration_ms: 1200,
  duration_api_ms: 900,
  num_turns: 2,
  stop_reason: 'end_turn',
  total_cost_usd: 0.0123,
  usage: resultUsage(10, 5),
  modelUsage: modelUsage(10, 5, 0.0123),
  permission_denials: [],
  session_id: SESSION,
}

export const resultSuccess: SDKResultSuccess = {
  ...resultCommon,
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done',
  uuid: uuid(6),
}

export const resultMaxTurns: SDKResultError = {
  ...resultCommon,
  type: 'result',
  subtype: 'error_max_turns',
  is_error: true,
  errors: ['Reached maximum number of turns (1)'],
  uuid: uuid(13),
}

// The result of a turn that was interrupted: the CLI ends it with an aborted terminal reason
export const resultInterrupted: SDKResultError = {
  ...resultCommon,
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  stop_reason: null,
  errors: [],
  terminal_reason: 'aborted_streaming',
  uuid: uuid(14),
}

export const rateLimited: SDKRateLimitEvent = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'rejected',
    resetsAt: 1_791_100_000,
    rateLimitType: 'five_hour',
    utilization: 1,
  },
  session_id: SESSION,
  uuid: uuid(7),
}

export const compacted: SDKCompactBoundaryMessage = {
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: { trigger: 'auto', pre_tokens: 150_000, post_tokens: 20_000 },
  session_id: SESSION,
  uuid: uuid(8),
}

export const retried: Extract<SDKMessage, { subtype: 'api_retry' }> = {
  type: 'system',
  subtype: 'api_retry',
  attempt: 1,
  max_retries: 3,
  retry_delay_ms: 2000,
  error_status: 529,
  error: 'overloaded',
  session_id: SESSION,
  uuid: uuid(9),
}

export const authFailed: SDKAuthStatusMessage = {
  type: 'auth_status',
  isAuthenticating: false,
  output: [],
  error: 'Not logged in',
  session_id: SESSION,
  uuid: uuid(10),
}

// A login that lapsed, as the probe saw it: a synthetic assistant message that carries the error, then an error result
export const authExpired: SDKAssistantMessage = {
  ...assistant(
    [
      {
        type: 'text',
        text: 'Failed to authenticate: OAuth session expired and could not be refreshed',
        citations: null,
      },
    ],
    12,
  ),
  error: 'authentication_failed',
}

export const resultApiError: SDKResultSuccess = {
  ...resultSuccess,
  duration_api_ms: 0,
  is_error: true,
  num_turns: 1,
  result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
  stop_reason: 'stop_sequence',
  total_cost_usd: 0,
  usage: resultUsage(0, 0),
  modelUsage: {},
  terminal_reason: 'api_error',
}
