import { ApiError, isProblem } from '../errors.js'

// The envelopes of effect/rpc in its JSON serialization (ADR-0013)
// A client sends Request, Ack, Interrupt and Ping; the daemon answers with Chunk, Exit, Defect and Pong

// One part of the cause of a failed exit: Fail carries the error, Die the defect, Interrupt neither
export interface CausePart {
  readonly _tag: string
  readonly error?: unknown
  readonly defect?: unknown
}

type Exit =
  | { readonly _tag: 'Success'; readonly value?: unknown }
  | { readonly _tag: 'Failure'; readonly cause: readonly CausePart[] }

export interface ChunkMessage {
  readonly _tag: 'Chunk'
  readonly requestId: string | number
  readonly values: readonly unknown[]
}

export interface ExitMessage {
  readonly _tag: 'Exit'
  readonly requestId: string | number
  readonly exit: Exit
}

// A failure of the whole connection, not of one request
interface DefectMessage {
  readonly _tag: 'Defect'
  readonly defect: unknown
}

interface PongMessage {
  readonly _tag: 'Pong'
}

export type ServerMessage = ChunkMessage | ExitMessage | DefectMessage | PongMessage

export interface RequestEnvelope {
  readonly id: string
  readonly tag: string
  readonly payload: unknown
  // Sent as the bearer token in the headers of the request, never in the url
  readonly token: string
}

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined

const tagOf = (value: unknown): unknown => field(value, '_tag')

const hasRequestId = (value: unknown): boolean => {
  const requestId = field(value, 'requestId')
  return typeof requestId === 'string' || typeof requestId === 'number'
}

const isCause = (value: unknown): value is readonly CausePart[] =>
  Array.isArray(value) && value.every((part) => typeof tagOf(part) === 'string')

const isExit = (value: unknown): value is Exit => {
  const tag = tagOf(value)
  return tag === 'Success' || (tag === 'Failure' && isCause(field(value, 'cause')))
}

const isServerMessage = (value: unknown): value is ServerMessage => {
  switch (tagOf(value)) {
    case 'Chunk': {
      return hasRequestId(value) && Array.isArray(field(value, 'values'))
    }
    case 'Exit': {
      return hasRequestId(value) && isExit(field(value, 'exit'))
    }
    case 'Defect':
    case 'Pong': {
      return true
    }
    default: {
      return false
    }
  }
}

const parsed = (text: string): unknown => {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    return undefined
  }
}

// A frame holds one message or a batch of them; anything else is noise the connection ignores
export const decodeFrame = (text: string): ServerMessage[] => {
  const value = parsed(text)
  const items: readonly unknown[] = Array.isArray(value) ? value : [value]
  return items.filter((item) => isServerMessage(item))
}

export const encodeRequest = ({ id, tag, payload, token }: RequestEnvelope): string =>
  JSON.stringify({
    _tag: 'Request',
    id,
    tag,
    payload,
    headers: [['authorization', `Bearer ${token}`]],
  })

export const encodeAck = (requestId: string): string => JSON.stringify({ _tag: 'Ack', requestId })

export const encodeInterrupt = (requestId: string): string =>
  JSON.stringify({ _tag: 'Interrupt', requestId })

export const encodePing = (): string => JSON.stringify({ _tag: 'Ping' })

// What a failure says about itself: a text, or the message of an error the daemon reported as { name, message }
export const reasonOf = (failure: unknown): string => {
  if (typeof failure === 'string') {
    return failure
  }
  const message = field(failure, 'message')
  return typeof message === 'string' ? message : 'no reason given'
}

// What a failed request is thrown as: the problem the daemon said no with, as an ApiError, or an Error that tells the cause
export const errorOf = (cause: readonly CausePart[], url: string): Error => {
  const problem = cause.map((part) => part.error).find((error) => isProblem(error))
  if (problem !== undefined) {
    return new ApiError(problem.status, problem, url)
  }
  if (cause.some((part) => tagOf(part) === 'Interrupt')) {
    return new Error('the request was interrupted')
  }
  const [first] = cause
  const failure = first === undefined ? undefined : (first.defect ?? first.error)
  return new Error(`the daemon failed the request: ${reasonOf(failure)}`)
}
