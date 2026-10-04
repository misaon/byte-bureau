import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { capturedLogs, linesOf } from '../testing/captured-logs.js'
import { fakeBun } from '../testing/fake-bun-secrets.js'
import { tempDir } from '../testing/temp-repo.js'
import { secretStoreFor } from './secret-store-for.js'

// What became of a call: the error it was refused with, else that it went through
const told = (outcome: PromiseSettledResult<unknown>): string =>
  outcome.status === 'rejected' ? String(outcome.reason) : 'fulfilled'

// Timers the test moves on itself, real again when it ends
const movedByTheTest = (): void => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
}

describe('secretStoreFor and a keychain that does not answer the probe', () => {
  it('takes the file for auto after 3 s, warning once with the keychain and the time it was given', async () => {
    expect.hasAssertions()
    fakeBun('holds')
    const logs = await capturedLogs()
    movedByTheTest()
    const chosen = secretStoreFor(tempDir('bb-home-'), 'auto')
    await vi.advanceTimersByTimeAsync(3000)
    await expect(chosen).resolves.toHaveProperty('backend', 'file')
    expect(linesOf(logs, 'bb.secrets')).toStrictEqual([
      ['warning', expect.stringMatching(/^the keychain did not answer within 3 s: /u)],
      ['debug', 'secrets backend: file (auto: the keychain did not answer within 3 s)'],
    ])
  })

  it('refuses keychain after 3 s, naming the time it gave the keychain', async () => {
    expect.hasAssertions()
    fakeBun('holds')
    movedByTheTest()
    const home = tempDir('bb-home-')
    const refusing = Promise.allSettled([secretStoreFor(home, 'keychain')])
    const [settled] = await Promise.all([refusing, vi.advanceTimersByTimeAsync(3000)])
    expect(settled.map((outcome) => told(outcome))).toStrictEqual([
      expect.stringMatching(/did not answer within 3 s.*secrets\.backend/u),
    ])
  })

  it('deletes the probe of a keychain that lets it in after the time', async () => {
    expect.hasAssertions()
    const keychain = fakeBun('holds')
    movedByTheTest()
    const chosen = secretStoreFor(tempDir('bb-home-'), 'auto')
    await vi.advanceTimersByTimeAsync(3000)
    await chosen
    keychain.release()
    await vi.waitFor(() => {
      expect([keychain.written, keychain.entries.size]).toStrictEqual([
        [`bytebureau/probe/${process.pid}`],
        0,
      ])
    })
  })
})

describe('secretStoreFor and a keychain that refuses the probe', () => {
  it('carries the error of the keychain into the refusal of keychain', async () => {
    expect.hasAssertions()
    fakeBun('refuses')
    await expect(secretStoreFor(tempDir('bb-home-'), 'keychain')).rejects.toThrow(
      /the keychain is locked.*secrets\.backend/u,
    )
  })
})
