import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { capturedLogs, linesOf } from '../testing/captured-logs.js'
import { fakeBun } from '../testing/fake-bun-secrets.js'
import { tempDir } from '../testing/temp-repo.js'
import { secretStoreFor } from './secret-store-for.js'

const recordIn = (home: string): string => path.join(home, 'secrets.backend')

const modeOf = (file: string): number => statSync(file).mode % 0o1000

describe('secretStoreFor and the backend auto chose', () => {
  it('records the choice of the first start for the user alone, and keeps the file where the keychain answers later', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    fakeBun('refuses')
    const first = await secretStoreFor(home, 'auto')
    const record = recordIn(home)
    expect([first.backend, readFileSync(record, 'utf8'), modeOf(record)]).toStrictEqual([
      'file',
      'file\n',
      0o600,
    ])
    fakeBun('answers')
    await expect(secretStoreFor(home, 'auto')).resolves.toHaveProperty('backend', 'file')
  })

  it('takes the keychain it recorded again while the keychain answers', async () => {
    expect.hasAssertions()
    fakeBun('answers')
    const home = tempDir('bb-home-')
    writeFileSync(recordIn(home), 'keychain\n')
    await expect(secretStoreFor(home, 'auto')).resolves.toHaveProperty('backend', 'keychain')
  })

  it('keeps a recorded keychain, taking the file with a warning while it does not answer', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    fakeBun('answers')
    const first = await secretStoreFor(home, 'auto')
    const logs = await capturedLogs()
    fakeBun('refuses')
    const meanwhile = await secretStoreFor(home, 'auto')
    expect([first.backend, meanwhile.backend, readFileSync(recordIn(home), 'utf8')]).toStrictEqual([
      'keychain',
      'file',
      'keychain\n',
    ])
    expect(linesOf(logs, 'bb.secrets')).toStrictEqual([
      [
        'warning',
        expect.stringMatching(
          /^the secrets kept in the keychain are not available \(the keychain refused the probe: the keychain is locked\)/u,
        ),
      ],
      ['debug', 'secrets backend: file (auto: the keychain it chose before is not available)'],
    ])
  })
})

describe('secretStoreFor and a record of the backend it does not go by', () => {
  it('lets file and keychain ignore the record, and write none', async () => {
    expect.hasAssertions()
    fakeBun('answers')
    const home = tempDir('bb-home-')
    writeFileSync(recordIn(home), 'keychain\n')
    const file = await secretStoreFor(home, 'file')
    writeFileSync(recordIn(home), 'file\n')
    const keychain = await secretStoreFor(home, 'keychain')
    const fresh = tempDir('bb-home-')
    await Promise.all([secretStoreFor(fresh, 'file'), secretStoreFor(fresh, 'keychain')])
    expect([file.backend, keychain.backend, existsSync(recordIn(fresh))]).toStrictEqual([
      'file',
      'keychain',
      false,
    ])
  })

  it('refuses a record that names neither backend instead of choosing again', async () => {
    expect.hasAssertions()
    fakeBun('answers')
    const home = tempDir('bb-home-')
    writeFileSync(recordIn(home), 'vault\n')
    await expect(secretStoreFor(home, 'auto')).rejects.toThrow(
      /secrets\.backend names neither keychain nor file/u,
    )
  })
})
