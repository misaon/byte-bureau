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

  it('counts an empty BYTEBUREAU_HOME as none, which would put the data in ./data', () => {
    expect(kernelHome({ BYTEBUREAU_HOME: '' })).toBe(DEFAULT)
  })
})

describe('kernelHome of a relative path', () => {
  it('resolves it against the working directory', () => {
    expect(kernelHome({ BYTEBUREAU_HOME: 'relative/home' })).toBe(path.resolve('relative/home'))
  })
})
