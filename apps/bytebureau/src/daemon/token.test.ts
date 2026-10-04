import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../testing/temp-repo.js'
import { freshToken, tokenFor, tokenPath } from './token.js'

const TOKEN = /^[0-9a-f]{64}$/u

const modeOf = (file: string): number => statSync(file).mode % 0o1000

describe('the daemon token', () => {
  it('is 64 hex characters and differs every time', () => {
    expect(freshToken()).toMatch(TOKEN)
    expect(freshToken()).not.toBe(freshToken())
  })

  it('is generated at the first start of a home, kept for the user alone, and the same at every later one', () => {
    const home = tempDir('bb-home-')
    const first = tokenFor(home)
    expect(first).toMatch(TOKEN)
    expect(modeOf(tokenPath(home))).toBe(0o600)
    expect(tokenFor(home)).toBe(first)
    expect(tokenFor(tempDir('bb-home-'))).not.toBe(first)
  })

  it('replaces a token file that holds no token', () => {
    const home = tempDir('bb-home-')
    writeFileSync(tokenPath(home), 'not a token\n')
    const token = tokenFor(home)
    expect(token).toMatch(TOKEN)
    expect(readFileSync(tokenPath(home), 'utf8').trim()).toBe(token)
  })
})
