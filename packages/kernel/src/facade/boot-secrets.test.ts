import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { InMemorySecretStore } from '../secrets/in-memory-secret-store.js'
import { tempDir } from '../testing/temp-repo.js'
import { bootSecrets } from './boot-secrets.js'

// A home whose user file holds the text given
const homeWith = (config: string): string => {
  const home = tempDir('bb-home-')
  writeFileSync(path.join(home, 'config.json'), config)
  return home
}

const KEYCHAIN = '{ "secrets": { "backend": "keychain" } }'

describe(bootSecrets, () => {
  it('takes the store the options give over the one the user file names', async () => {
    expect.hasAssertions()
    const given = new InMemorySecretStore()
    await expect(bootSecrets({ home: homeWith(KEYCHAIN), env: {}, secrets: given })).resolves.toBe(
      given,
    )
  })

  it('takes the backend the user file names, and auto where it names none', async () => {
    expect.hasAssertions()
    await expect(bootSecrets({ home: homeWith(KEYCHAIN), env: {} })).rejects.toThrow(/keychain/u)
    const none = await bootSecrets({ home: tempDir('bb-home-'), env: {} })
    expect(none.backend).toBe('file')
  })

  it('reads the secrets section even where another section of the user file cannot be read', async () => {
    expect.hasAssertions()
    const home = homeWith(
      '{ "server": { "port": "not a port" }, "secrets": { "backend": "keychain" } }',
    )
    await expect(bootSecrets({ home, env: {} })).rejects.toThrow(/keychain/u)
  })

  it('leaves the backend to auto where the user file cannot be parsed or names no known one', async () => {
    expect.hasAssertions()
    const broken = await bootSecrets({ home: homeWith('{ "secrets": '), env: {} })
    const unknown = await bootSecrets({
      home: homeWith('{ "secrets": { "backend": "vault" } }'),
      env: {},
    })
    expect([broken.backend, unknown.backend]).toStrictEqual(['file', 'file'])
  })
})
