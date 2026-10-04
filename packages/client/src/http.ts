import type { AskAnswer, PromptInput } from '@bytebureau/protocol'
import { ApiError, isProblem } from './errors.js'
import { createClient, createConfig, type Client } from './gen/client/index.js'
import type { AsksAnswerData, SessionsPromptData } from './gen/types.gen.js'

export interface HttpOptions {
  readonly baseUrl: string
  readonly token: string
  readonly fetch?: typeof fetch | undefined
}

// What a function of the generated SDK resolves with: it never rejects, a failure comes back as its error
interface Answer<Data> {
  readonly data?: Data | undefined
  readonly error?: unknown
  readonly request?: Request | undefined
  readonly response?: Response | undefined
}

type Call<Options, Data> = (options: Options) => Promise<Answer<Data>>

// The methods of a client, each made of a function of the generated SDK and the options its arguments make
export interface Http {
  // The generated client of this daemon alone, so two clients in one process never share a url or a token
  readonly client: Client
  // A 2xx answer gives its data; any other answer, or none, is thrown as an ApiError
  readonly data: <Args extends readonly unknown[], Options, Data>(
    call: Call<Options, Data>,
    optionsOf: (...args: Args) => Options,
  ) => (...args: Args) => Promise<Data>
  // The same for a lookup: an answer of 404 is nothing, not a failure
  readonly lookup: <Args extends readonly unknown[], Options, Data>(
    call: Call<Options, Data>,
    optionsOf: (...args: Args) => Options,
  ) => (...args: Args) => Promise<Data | undefined>
  // The same for a command the daemon answers with no content
  readonly done: <Args extends readonly unknown[], Options>(
    call: Call<Options, unknown>,
    optionsOf: (...args: Args) => Options,
  ) => (...args: Args) => Promise<void>
}

const failureOf = (answer: Answer<unknown>, baseUrl: string): ApiError => {
  const url = answer.request === undefined ? baseUrl : answer.request.url
  if (answer.response === undefined) {
    return new ApiError(0, undefined, { url, cause: answer.error })
  }
  const problem = isProblem(answer.error) ? answer.error : undefined
  return new ApiError(answer.response.status, problem, url)
}

// The data of an answer: a 2xx with a body gives it; any other answer, or none, is thrown as an ApiError
const valueOf = <Data>(answer: Answer<Data>, baseUrl: string): Data => {
  const { response, data } = answer
  if (response === undefined || !response.ok) {
    throw failureOf(answer, baseUrl)
  }
  // A 2xx without a body gives null for data, and the API answers every query with one
  if (data === undefined || data === null) {
    throw new ApiError(response.status, undefined, response.url)
  }
  return data
}

const isNotFound = ({ response }: Answer<unknown>): boolean =>
  response !== undefined && response.status === 404

export const http = ({ baseUrl, token, fetch: fetchImpl }: HttpOptions): Http => {
  const fetchOption = fetchImpl === undefined ? {} : { fetch: fetchImpl }
  return {
    client: createClient(createConfig({ baseUrl, auth: token, ...fetchOption })),
    data:
      (call, optionsOf) =>
      async (...args) => {
        const answer = await call(optionsOf(...args))
        return valueOf(answer, baseUrl)
      },
    lookup:
      (call, optionsOf) =>
      async (...args) => {
        const answer = await call(optionsOf(...args))
        return isNotFound(answer) ? undefined : valueOf(answer, baseUrl)
      },
    done:
      (call, optionsOf) =>
      async (...args) => {
        const answer = await call(optionsOf(...args))
        if (answer.response === undefined || !answer.response.ok) {
          throw failureOf(answer, baseUrl)
        }
      },
  }
}

// The protocol's types are readonly, the generated bodies take mutable arrays: a copy fits both
export const promptBody = ({ text, attachments }: PromptInput): SessionsPromptData['body'] =>
  attachments === undefined ? { text } : { text, attachments: [...attachments] }

export const answerBody = (answer: AskAnswer): AsksAnswerData['body'] => ({
  ...answer,
  selected: typeof answer.selected === 'string' ? answer.selected : [...answer.selected],
})
