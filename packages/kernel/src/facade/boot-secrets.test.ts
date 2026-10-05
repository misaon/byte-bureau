import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError } from '../errors.js'
import { InMemorySecretStore } from '../secrets/in-memory-secret-store.js'
import { withoutBun } from '../testing/fake-bun-secrets.js'
import { tempDir } from '../testing/temp-repo.js'
import { bootSecrets } from './boot-secrets.js'

// A home whose user file holds the text given; Bun is taken away, so no test can reach a real keychain
const homeWith = (config: string): string => {
  withoutBun()
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
    const unnamed = await bootSecrets({ home: homeWith('{ "server": { "port": 0 } }'), env: {} })
    expect([none.backend, unnamed.backend]).toStrictEqual(['file', 'file'])
  })

  it('reads the secrets section even where another section of the user file cannot be read', async () => {
    expect.hasAssertions()
    const home = homeWith(
      '{ "server": { "port": "not a port" }, "secrets": { "backend": "keychain" } }',
    )
    await expect(bootSecrets({ home, env: {} })).rejects.toThrow(/keychain/u)
  })
})

describe('bootSecrets and a secrets section it cannot go by', () => {
  it('refuses a backend that is none of the three, naming its place and the three', async () => {
    expect.hasAssertions()
    const refused = bootSecrets({
      home: homeWith('{ "secrets": { "backend": "vault" } }'),
      env: {},
    })
    await expect(refused).rejects.toBeInstanceOf(ConfigError)
    await expect(refused).rejects.toHaveProperty('pointer', '/secrets/backend')
    await expect(refused).rejects.toThrow(/^expected "auto", "keychain" or "file", not "vault"$/u)
  })

  it('refuses a secrets section that is no object', async () => {
    expect.hasAssertions()
    const refused = bootSecrets({ home: homeWith('{ "secrets": "file" }'), env: {} })
    await expect(refused).rejects.toBeInstanceOf(ConfigError)
    await expect(refused).rejects.toHaveProperty('pointer', '/secrets')
  })

  it('refuses the start where the user file cannot be parsed, naming the file, and records no backend', async () => {
    expect.hasAssertions()
    const home = homeWith('{ "secrets": { "backend": "file" ')
    const refused = bootSecrets({ home, env: {} })
    await expect(refused).rejects.toBeInstanceOf(ConfigError)
    await expect(refused).rejects.toHaveProperty('file', path.join(home, 'config.json'))
    expect(existsSync(path.join(home, 'secrets.backend'))).toBe(false)
  })
})
