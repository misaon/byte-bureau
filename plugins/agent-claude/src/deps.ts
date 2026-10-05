import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Logger } from '@bytebureau/plugin-api'

// The part of the SDK's query the adapter drives; the SDK's own query() is one, and so is the fake of the tests
export type AgentQuery = AsyncIterable<SDKMessage> &
  Pick<Query, 'interrupt' | 'close' | 'setModel' | 'initializationResult' | 'accountInfo'>

export type QueryFn = (params: {
  readonly prompt: AsyncIterable<SDKUserMessage>
  readonly options: Options
}) => AgentQuery

// What the provider, its sessions and its login check are given
export interface ClaudeDeps {
  readonly query: QueryFn
  readonly logger: Logger
  readonly resolveExecutable?: ((name: string) => string | undefined) | undefined
}
