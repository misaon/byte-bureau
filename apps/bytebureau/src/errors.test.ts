import { ConfigError, ProviderError, StoreError, WorkspaceError } from '@bytebureau/kernel'
import { describe, expect, it } from 'vitest'
import { describeError } from './errors.js'
import { typedError } from './testing/typed-error.js'

describe(describeError, () => {
  it('says what an error with a message says, and no more', () => {
    expect(describeError(new Error('boom'))).toBe('boom')
    const inner = new Error('inner')
    expect(describeError(new Error('outer', { cause: inner }))).toBe('outer')
  })

  it('tells a value that is no error as text', () => {
    expect(describeError('oops')).toBe('oops')
    expect(describeError(42)).toBe('42')
  })

  it('prints the name, the reason and the code of a typed error of the kernel', () => {
    const error = new WorkspaceError({
      code: 'not_a_repository',
      reason: '/tmp/x is not inside a git repository',
    })
    expect(describeError(error)).toBe(
      'WorkspaceError: /tmp/x is not inside a git repository (not_a_repository)',
    )
  })

  it('names the file and the JSON pointer of a configuration error', () => {
    const error = new ConfigError({
      file: '/repo/bytebureau.json',
      pointer: '/employees/developer/model',
      reason: 'Expected a string',
    })
    expect(describeError(error)).toBe(
      'ConfigError: Expected a string (/repo/bytebureau.json/employees/developer/model)',
    )
  })

  it('names the file alone when a configuration error has no pointer', () => {
    const error = new ConfigError({
      file: '/repo/bytebureau.json',
      pointer: '',
      reason: 'both exist',
    })
    expect(describeError(error)).toBe('ConfigError: both exist (/repo/bytebureau.json)')
  })

  it('names the kind of a provider error', () => {
    const error = new ProviderError({ kind: 'auth', reason: 'not logged in', retryable: false })
    expect(describeError(error)).toBe('ProviderError: not logged in (auth)')
  })
})

describe('describeError for an error that names a cause, or nothing', () => {
  it('prints the cause of a store error', () => {
    const store = new StoreError({ cause: new Error('FOREIGN KEY constraint failed') })
    expect(describeError(store)).toBe('StoreError: FOREIGN KEY constraint failed')
  })

  it('digs through the causes, whatever kind of value the innermost one is', () => {
    const inner = typedError('SqlError', { cause: 'disk full' })
    expect(describeError(new StoreError({ cause: inner }))).toBe('StoreError: SqlError: disk full')
  })

  it('adds what the errors behind a store error say, without telling the same twice', () => {
    const sqlite = new Error('FOREIGN KEY constraint failed')
    const inner = new Error('Failed to execute statement', { cause: sqlite })
    const sql = new Error('Failed to execute statement', { cause: inner })
    expect(describeError(new StoreError({ cause: sql }))).toBe(
      'StoreError: Failed to execute statement: FOREIGN KEY constraint failed',
    )
  })

  it('prints the bare name of an error that has neither a message nor any fields', () => {
    expect(describeError(typedError('AskError', {}))).toBe('AskError')
  })
})
