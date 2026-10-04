import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../testing/temp-repo.js'
import { FileSecretStore } from './file-secret-store.js'

const modeOf = (file: string): number => statSync(file).mode % 0o1000

// The secrets file in a fresh directory removed after the test, or in a subdirectory of it that is not there yet
const fileIn = (directory = ''): string =>
  path.join(tempDir('bb-secrets-'), directory, 'secrets.json')

describe(FileSecretStore, () => {
  it('keeps a value across stores of the same file, in a file only the user can read', async () => {
    expect.hasAssertions()
    const file = fileIn()
    const first = new FileSecretStore(file)
    await first.set('profiles/claude/work/api_key', 'sk-test-1')
    const second = new FileSecretStore(file)
    await expect(second.get('profiles/claude/work/api_key')).resolves.toBe('sk-test-1')
    expect(modeOf(file)).toBe(0o600)
    expect(readFileSync(file, 'utf8')).toContain('sk-test-1')
  })

  it('answers nothing for a key it does not hold, and forgets a deleted one', async () => {
    expect.hasAssertions()
    const store = new FileSecretStore(fileIn())
    await expect(store.get('missing')).resolves.toBeUndefined()
    await store.set('k', 'v')
    await expect(store.get('toString')).resolves.toBeUndefined()
    await store.delete('k')
    await expect(store.get('k')).resolves.toBeUndefined()
    expect(store.backend).toBe('file')
  })

  it('writes no file to delete a key it does not hold', async () => {
    expect.hasAssertions()
    const file = fileIn()
    await new FileSecretStore(file).delete('missing')
    expect(existsSync(file)).toBe(false)
  })

  it('refuses a file whose content is not the store, instead of overwriting it', async () => {
    expect.hasAssertions()
    const file = fileIn()
    writeFileSync(file, 'not json')
    const store = new FileSecretStore(file)
    await expect(store.set('k', 'v')).rejects.toThrow(/secrets\.json does not hold a secret store/u)
    writeFileSync(file, '{ "k": 1 }')
    await expect(store.get('k')).rejects.toThrow(/secrets\.json/u)
    expect(readFileSync(file, 'utf8')).toBe('{ "k": 1 }')
  })

  it('creates its directory for the user alone', async () => {
    expect.hasAssertions()
    const file = fileIn('home')
    await new FileSecretStore(file).set('k', 'v')
    expect(modeOf(path.dirname(file))).toBe(0o700)
  })
})
