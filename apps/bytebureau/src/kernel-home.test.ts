import { homedir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { kernelHome } from './kernel-home.js'

const DEFAULT = path.join(homedir(), '.bytebureau')

describe(kernelHome, () => {
  it('is the BYTEBUREAU_HOME of the environment', () => {
    expect(kernelHome({ BYTEBUREAU_HOME: '/data/bytebureau' })).toBe('/data/bytebureau')
  })

  it('is .bytebureau in the home of the user when the environment names none', () => {
    expect(kernelHome({})).toBe(DEFAULT)
    expect(kernelHome({ BYTEBUREAU_HOME: undefined })).toBe(DEFAULT)
  })

  it('refuses an empty BYTEBUREAU_HOME, naming the variable, instead of taking it for the home of the user', () => {
    expect(() => kernelHome({ BYTEBUREAU_HOME: '' })).toThrow(/^BYTEBUREAU_HOME is set but empty/u)
    expect(() => kernelHome({ BYTEBUREAU_HOME: ' ' })).toThrow(/BYTEBUREAU_HOME/u)
  })
})

describe('kernelHome of a relative path', () => {
  it('resolves it against the working directory', () => {
    expect(kernelHome({ BYTEBUREAU_HOME: 'relative/home' })).toBe(path.resolve('relative/home'))
  })
})
