import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Logger } from '@bytebureau/plugin-api'

// The part of the SDK's query the adapter drives; the SDK's own query() is one, and so is the fake of the tests
export type AgentQuery = AsyncIterable<SDKMessage> &
  Pick<
    Query,
    'interrupt' | 'close' | 'setModel' | 'initializationResult' | 'accountInfo' | 'getContextUsage'
  >

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

type QueryParams = Parameters<QueryFn>[0]

// A query the SDK could not start: everything asked of it fails with the reason, and closing it is harmless
const failedQuery = (cause: unknown): AgentQuery => {
  const reason = cause instanceof Error ? cause : new Error(String(cause))
  const failing = async (): Promise<never> => {
    await Promise.resolve()
    throw reason
  }
  return {
    [Symbol.asyncIterator]: () => ({ next: failing }),
    interrupt: failing,
    close: () => {
      // Nothing was started, so there is nothing to close
    },
    setModel: failing,
    initializationResult: failing,
    accountInfo: failing,
    getContextUsage: failing,
  }
}

// The SDK throws at once when it finds no Claude Code to run; the caller hears of it as of any query that fails
export const startQuery = (deps: ClaudeDeps, params: QueryParams): AgentQuery => {
  try {
    return deps.query(params)
  } catch (error) {
    return failedQuery(error)
  }
}
