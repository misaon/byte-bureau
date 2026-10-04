import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { PROBLEM_CODES, Problem, problemType } from './problem.js'

describe('problem details', () => {
  it('names the type of a code under the ByteBureau problems base', () => {
    expect(problemType('not_found')).toBe('https://bytebureau.dev/problems/not_found')
  })

  it('decodes a problem with and without an instance', () => {
    const problem = {
      type: problemType('session_not_found'),
      title: 'Not Found',
      status: 404,
      detail: 'no session 42',
      code: 'session_not_found',
    }
    expect(Schema.decodeUnknownSync(Problem)(problem)).toStrictEqual(problem)
    const located = { ...problem, instance: '/api/v1/sessions/42' }
    expect(Schema.decodeUnknownSync(Problem)(located)).toStrictEqual(located)
  })

  it('lists the well-known codes once each, in snake case', () => {
    expect.hasAssertions()
    expect(new Set(PROBLEM_CODES).size).toBe(PROBLEM_CODES.length)
    for (const code of PROBLEM_CODES) {
      for (const word of code.split('_')) {
        expect(word, code).toMatch(/^[a-z]+$/u)
      }
    }
  })
})
