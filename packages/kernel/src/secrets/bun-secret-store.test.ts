import { Effect } from 'effect'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { StoreError } from '../errors.js'
import { usableKeyOf } from '../profiles/profile-keys.js'
import { fakeBun, type FakeBun, type FakeKeychain } from '../testing/fake-bun-secrets.js'
import { BunSecretStore, bunSecrets } from './bun-secret-store.js'

const UNANSWERED =
  /^the keychain did not answer within 10 s — a Keychain dialog may be waiting for approval, or set secrets\.backend to file$/u

// Timers the test moves on itself, real again when it ends
const movedByTheTest = (): void => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
}

// The store over a fake keychain, under a service of the tests
function storeOver(keychain: FakeKeychain): {
  readonly store: BunSecretStore
  readonly fake: FakeBun
} {
  const fake = fakeBun(keychain)
  const secrets = bunSecrets()
  if (secrets === undefined) {
    throw new Error('the fake Bun offers no secrets')
  }
  return { store: new BunSecretStore(secrets, 'bytebureau-test'), fake }
}

// Why the call failed once 10 s went by, else that it did not
async function after10s(call: Promise<unknown>): Promise<string> {
  const [settled] = await Promise.all([
    Promise.allSettled([call]),
    vi.advanceTimersByTimeAsync(10_000),
  ])
  const [outcome] = settled
  return outcome.status === 'rejected' ? String(outcome.reason) : 'fulfilled'
}

describe('the keychain store, when the keychain does not answer', () => {
  it('refuses a read after 10 s, naming the keychain and the way out', async () => {
    expect.hasAssertions()
    const { store, fake } = storeOver('answers')
    fake.holdReads()
    movedByTheTest()
    await expect(after10s(store.get('k'))).resolves.toMatch(/^Error: the keychain did not answer/u)
  })

  it('refuses a write after 10 s the same way', async () => {
    expect.hasAssertions()
    const { store } = storeOver('holds')
    movedByTheTest()
    await expect(after10s(store.set('k', 'v'))).resolves.toMatch(/within 10 s.*secrets\.backend/u)
  })

  it('is a store error of the kernel when the key of a profile cannot be read in time', async () => {
    expect.hasAssertions()
    const { store, fake } = storeOver('answers')
    fake.holdReads()
    movedByTheTest()
    const failing = Effect.runPromise(Effect.flip(usableKeyOf(store, 'fake/key')))
    const [error] = await Promise.all([failing, vi.advanceTimersByTimeAsync(10_000)])
    expect(error).toBeInstanceOf(StoreError)
    expect(error.message).toMatch(UNANSWERED)
  })
})

describe('the keychain store, when the keychain answers', () => {
  it('keeps its entries under its service and clears the timer of every call', async () => {
    expect.hasAssertions()
    const { store, fake } = storeOver('answers')
    movedByTheTest()
    await store.set('k', 'v')
    const read = await store.get('k')
    expect([read, [...fake.entries]]).toStrictEqual(['v', [['bytebureau-test/k', 'v']]])
    await store.delete('k')
    expect([fake.entries.size, vi.getTimerCount()]).toStrictEqual([0, 0])
  })
})
