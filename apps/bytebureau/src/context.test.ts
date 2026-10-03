import { describe, expect, it } from 'vitest'
import { createContext, globalArgs, type GlobalArgs } from './context.js'

const QUIET: GlobalArgs = { json: false, color: false, yes: false }

describe(createContext, () => {
  it('passes --debug and --log-level on, unchanged, as the logging of the context', () => {
    const args = { ...QUIET, debug: 'bb.agent,!bb.store', 'log-level': 'warn' }
    expect(createContext(args, {}, false).logging).toStrictEqual({
      debug: 'bb.agent,!bb.store',
      level: 'warn',
    })
  })

  it('leaves the logging to the defaults of the kernel when neither flag is given', () => {
    expect(createContext(QUIET, {}, false).logging).toStrictEqual({
      debug: undefined,
      level: undefined,
    })
  })

  it('keeps an empty --debug, which asks for every category', () => {
    expect(createContext({ ...QUIET, debug: '' }, {}, false).logging).toStrictEqual({
      debug: '',
      level: undefined,
    })
  })

  it('is interactive at a terminal, and not when the output is JSON or goes to a pipe', () => {
    expect(createContext(QUIET, {}, true).interactive).toBe(true)
    expect(createContext({ ...QUIET, json: true }, {}, true).interactive).toBe(false)
    expect(createContext(QUIET, {}, false).interactive).toBe(false)
  })
})

describe('the global flags', () => {
  it('names the flags the way a person types them', () => {
    expect(Object.keys(globalArgs)).toStrictEqual([
      'lang',
      'json',
      'color',
      'yes',
      'debug',
      'log-level',
    ])
  })

  it('says what --yes does: it answers only the asks that have a recommended option', () => {
    expect(globalArgs.yes.description).toBe(
      'Answer every ask that has a recommended option with it',
    )
  })
})
