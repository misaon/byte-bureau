import type { EventEnvelope, EventsFilter, Problem } from '@bytebureau/protocol'
import { EventSourceParserStream, type EventSourceMessage } from 'eventsource-parser/stream'
import { ApiError, isProblem } from './errors.js'

export interface SubscribeOptions {
  readonly baseUrl: string
  readonly token: string
  readonly filter: EventsFilter
  readonly signal?: AbortSignal | undefined
  readonly fetch?: typeof fetch | undefined
  // The first pause before a reconnect; it doubles up to 30 s and starts over once a connection opens
  readonly backoffMs?: number | undefined
  // How long reconnecting may keep failing before the subscription gives up
  readonly retryFor?: number | undefined
}

const FIRST_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 30_000
const RETRY_FOR_MS = 30_000

// Where a subscription stands between its connections
interface State {
  readonly options: SubscribeOptions
  // The seq of the last durable event received; a reconnect resumes after it
  lastSeq: number | undefined
  // The pause the next attempt waits first; none before the first attempt
  backoff: number | undefined
  // When the attempts began to fail, for as long as none has opened since
  failingSince: number | undefined
}

const aborted = (signal: AbortSignal | undefined): boolean => signal !== undefined && signal.aborted

const queryOf = (filter: EventsFilter, since: number | undefined): string => {
  const types = (filter.types ?? []).join(',')
  const params = new URLSearchParams()
  for (const [key, value] of [
    ['since', since === undefined ? undefined : String(since)],
    ['session', filter.sessionId],
    ['project', filter.projectId],
    ['types', types === '' ? undefined : types],
  ] as const) {
    if (value !== undefined) {
      params.set(key, value)
    }
  }
  const text = params.toString()
  return text === '' ? '' : `?${text}`
}

const urlOf = ({ options, lastSeq }: State): string =>
  `${options.baseUrl}/api/v1/events${queryOf(options.filter, lastSeq ?? options.filter.since)}`

// The bearer token always; the last seq seen once there is one to resume after
const headersOf = (token: string, lastSeq: number | undefined): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: 'text/event-stream',
  ...(lastSeq === undefined ? {} : { 'last-event-id': String(lastSeq) }),
})

// Waits the pause, or less when the signal aborts meanwhile; says whether the whole pause has passed
const pause = async (ms: number | undefined, signal: AbortSignal | undefined): Promise<boolean> => {
  if (ms === undefined || aborted(signal)) {
    return false
  }
  const watched = signal ?? new AbortController().signal
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const timer = setTimeout(resolve, ms, true)
  const stop = (): void => {
    clearTimeout(timer)
    resolve(false)
  }
  watched.addEventListener('abort', stop, { once: true })
  const passed = await promise
  watched.removeEventListener('abort', stop)
  return passed
}

// An answer that asking again will not change ends the subscription: a 4xx other than a timeout or a rate limit
const isFinal = (status: number): boolean =>
  status >= 400 && status < 500 && status !== 408 && status !== 429

const problemIn = async (response: Response): Promise<Problem | undefined> => {
  try {
    const body: unknown = await response.json()
    return isProblem(body) ? body : undefined
  } catch {
    return undefined
  }
}

// The frames of a body, read one at a time; leaving early cancels the body, which closes the connection
const messagesOf = (
  frames: ReadableStream<EventSourceMessage>,
): AsyncIterable<EventSourceMessage> => {
  const reader = frames.getReader()
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const read = await reader.read()
        return read.done ? { done: true, value: undefined } : { done: false, value: read.value }
      },
      return: async () => {
        try {
          await reader.cancel()
        } catch {
          // The body failed already: there is nothing left to cancel
        }
        return { done: true, value: undefined }
      },
    }),
  }
}

// What an answer that is not the stream fails the attempt with: an ApiError when asking again will not help
const refusalOf = async (response: Response, url: string): Promise<Error> => {
  if (isFinal(response.status)) {
    return new ApiError(response.status, await problemIn(response), url)
  }
  if (response.body !== null) {
    await response.body.cancel()
  }
  return new Error(`the daemon answered ${response.status}`)
}

// One connection, open: the daemon answered with the stream, so the next failure starts a new count
const opened = async (url: string, state: State): Promise<AsyncIterable<EventSourceMessage>> => {
  const { fetch: fetchImpl = fetch, signal, token } = state.options
  const init = {
    headers: headersOf(token, state.lastSeq),
    ...(signal === undefined ? {} : { signal }),
  }
  const response = await fetchImpl(url, init)
  if (!response.ok || response.body === null) {
    throw await refusalOf(response, url)
  }
  state.backoff = undefined
  state.failingSince = undefined
  return messagesOf(
    response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()),
  )
}

const isEnvelope = (value: unknown): value is EventEnvelope =>
  typeof value === 'object' &&
  value !== null &&
  Number.isInteger(Reflect.get(value, 'seq')) &&
  ['id', 'ts', 'type'].every((key) => typeof Reflect.get(value, key) === 'string')

// The envelope a frame carries; a frame that carries none is skipped
const envelopeOf = (message: EventSourceMessage): EventEnvelope | undefined => {
  try {
    const parsed: unknown = JSON.parse(message.data)
    return isEnvelope(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

async function* eventsOf(
  messages: AsyncIterable<EventSourceMessage>,
  state: State,
): AsyncGenerator<EventEnvelope> {
  const { filter, signal } = state.options
  for await (const message of messages) {
    const event = envelopeOf(message)
    if (aborted(signal)) {
      return
    }
    if (event !== undefined && event.seq !== 0) {
      state.lastSeq = event.seq
    }
    if (event !== undefined && (event.seq !== 0 || filter.ephemeral !== false)) {
      yield event
    }
  }
}

// A failed attempt ends the subscription when the daemon said no or reconnecting has failed for too long
const failed = (state: State, url: string, error: unknown): void => {
  if (aborted(state.options.signal)) {
    return
  }
  if (error instanceof ApiError) {
    throw error
  }
  const now = Date.now()
  state.failingSince ??= now
  if (now - state.failingSince > (state.options.retryFor ?? RETRY_FOR_MS)) {
    throw new ApiError(0, undefined, { url, cause: error })
  }
}

const nextBackoff = ({ backoff, options }: State): number =>
  backoff === undefined
    ? (options.backoffMs ?? FIRST_BACKOFF_MS)
    : Math.min(MAX_BACKOFF_MS, backoff * 2)

// One attempt: the pause it owes, then one connection whose events it yields until the connection ends
async function* attempt(state: State): AsyncGenerator<EventEnvelope> {
  await pause(state.backoff, state.options.signal)
  if (aborted(state.options.signal)) {
    return
  }
  const url = urlOf(state)
  try {
    yield* eventsOf(await opened(url, state), state)
  } catch (error) {
    failed(state, url, error)
  }
  state.backoff = nextBackoff(state)
}

/**
 * The events of the daemon from the filter's `since` on, resumed with `Last-Event-ID` after every end of a connection.
 * Ends quietly when the signal aborts. Throws an ApiError when the daemon refuses the subscription (a 4xx such as
 * 401 or 403), or once reconnecting has failed for longer than `retryFor`.
 */
export async function* subscribeEvents(options: SubscribeOptions): AsyncGenerator<EventEnvelope> {
  const state: State = { options, lastSeq: undefined, backoff: undefined, failingSince: undefined }
  while (!aborted(options.signal)) {
    yield* attempt(state)
  }
}
