import type { Problem } from '@bytebureau/protocol'

// The url a request went to and, when it got no answer at all, what it failed with
export interface RequestTarget {
  readonly url: string
  readonly cause?: unknown
}

const messageOf = (
  status: number,
  problem: Problem | undefined,
  url: string | undefined,
): string => {
  if (problem !== undefined) {
    return `${problem.detail} (${problem.code})`
  }
  return status === 0
    ? `cannot reach the daemon at ${url ?? 'an unknown url'}`
    : `the daemon answered ${status}`
}

const targetOf = (target: string | RequestTarget | undefined): RequestTarget | undefined =>
  typeof target === 'string' ? { url: target } : target

/** What the daemon said no with: a problem, a bare status, or nothing at all because it could not be reached (status 0). */
export class ApiError extends Error {
  public override readonly name = 'ApiError'
  /** The HTTP status of the answer; 0 when no answer came. */
  public readonly status: number
  /** The RFC 9457 problem the daemon answered with, if it sent one. */
  public readonly problem: Problem | undefined
  /** The url of the request. */
  public readonly url: string | undefined

  /**
   * @param status The HTTP status of the answer, 0 when no answer came.
   * @param problem The problem the answer carried, if any.
   * @param target The url of the request, or the url and what the request failed with.
   */
  public constructor(
    status: number,
    problem: Problem | undefined,
    target?: string | RequestTarget,
  ) {
    const { url, cause } = targetOf(target) ?? {}
    super(messageOf(status, problem, url), cause === undefined ? undefined : { cause })
    this.status = status
    this.problem = problem
    this.url = url
  }
}

const hasStrings = (value: object, keys: readonly string[]): boolean =>
  keys.every((key) => typeof Reflect.get(value, key) === 'string')

// An RFC 9457 problem with the code of ByteBureau, as the daemon sends one
export const isProblem = (value: unknown): value is Problem =>
  typeof value === 'object' &&
  value !== null &&
  typeof Reflect.get(value, 'status') === 'number' &&
  hasStrings(value, ['type', 'title', 'detail', 'code'])
