import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { tempDir } from '../testing/temp-repo.js'
import { secretStoreFor } from './secret-store-for.js'

describe(secretStoreFor, () => {
  it('gives the file store for file, and for auto where there is no Bun', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const file = await secretStoreFor(home, 'file')
    const auto = await secretStoreFor(home, 'auto')
    expect([file.backend, auto.backend]).toStrictEqual(['file', 'file'])
    await file.set('k', 'v')
    await expect(auto.get('k')).resolves.toBe('v')
    expect(existsSync(path.join(home, 'secrets.json'))).toBe(true)
  })

  it('refuses the keychain where it is not available instead of falling back silently', async () => {
    expect.hasAssertions()
    await expect(secretStoreFor(tempDir('bb-home-'), 'keychain')).rejects.toThrow(
      /keychain.*secrets\.backend/u,
    )
  })
})

interface Entry {
  readonly service: string
  readonly name: string
  readonly value?: string
}

const keyOf = ({ service, name }: Entry): string => `${service}/${name}`

// Bun.secrets as a map, for the choice of the store only; one that refuses every write stands for a locked keychain
function fakeBun(refusing: boolean): Map<string, string> {
  const entries = new Map<string, string>()
  const secrets = {
    get: async (entry: Entry): Promise<string | null> => {
      await Promise.resolve()
      return entries.get(keyOf(entry)) ?? null
    },
    set: async (entry: Entry): Promise<void> => {
      await Promise.resolve()
      if (refusing) {
        throw new Error('the keychain is locked')
      }
      entries.set(keyOf(entry), entry.value ?? '')
    },
    delete: async (entry: Entry): Promise<boolean> => {
      await Promise.resolve()
      return entries.delete(keyOf(entry))
    },
  }
  vi.stubGlobal('Bun', { secrets })
  onTestFinished(() => {
    vi.unstubAllGlobals()
  })
  return entries
}

describe('secretStoreFor where Bun offers its secrets', () => {
  it('takes the keychain for auto and keychain once the probe went in and out, leaving nothing of it', async () => {
    expect.hasAssertions()
    const entries = fakeBun(false)
    const home = tempDir('bb-home-')
    const auto = await secretStoreFor(home, 'auto')
    const keychain = await secretStoreFor(home, 'keychain')
    expect([auto.backend, keychain.backend, entries.size]).toStrictEqual([
      'keychain',
      'keychain',
      0,
    ])
    await auto.set('k', 'v')
    expect([...entries]).toStrictEqual([['bytebureau/k', 'v']])
    expect(existsSync(path.join(home, 'secrets.json'))).toBe(false)
  })

  it('falls back to the file for auto, and refuses keychain, when the keychain refuses the probe', async () => {
    expect.hasAssertions()
    fakeBun(true)
    const home = tempDir('bb-home-')
    await expect(secretStoreFor(home, 'auto')).resolves.toHaveProperty('backend', 'file')
    await expect(secretStoreFor(home, 'keychain')).rejects.toThrow(/keychain/u)
  })
})
