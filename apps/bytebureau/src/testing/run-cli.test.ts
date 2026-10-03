import { existsSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { childEnv } from './run-cli.js'

function homeOf(env: Readonly<Record<string, string>>): string {
  return env['BYTEBUREAU_HOME'] ?? ''
}

describe(childEnv, () => {
  it('keeps git away from the configuration of the person who runs the tests', () => {
    const env = childEnv({})
    expect(env['GIT_CONFIG_GLOBAL']).toBe('/dev/null')
    expect(env['GIT_CONFIG_NOSYSTEM']).toBe('1')
  })

  it('gives the CLI a home of its own, an existing directory under the temp dir, when none is named', () => {
    const first = homeOf(childEnv({}))
    const second = homeOf(childEnv({}))
    expect(existsSync(first)).toBe(true)
    const temp = realpathSync(tmpdir())
    expect(first.startsWith(temp)).toBe(true)
    expect(first).not.toBe(second)
    expect(first).not.toBe(path.join(homedir(), '.bytebureau'))
  })

  it('keeps the home that a test names, and the other variables it sets', () => {
    const env = childEnv({ BYTEBUREAU_HOME: '/data/bytebureau', FORCE_COLOR: '1' })
    expect(homeOf(env)).toBe('/data/bytebureau')
    expect(env['FORCE_COLOR']).toBe('1')
  })
})
