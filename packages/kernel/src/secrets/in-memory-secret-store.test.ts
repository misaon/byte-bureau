import { describe, expect, it } from 'vitest'
import { InMemorySecretStore } from './in-memory-secret-store.js'

describe(InMemorySecretStore, () => {
  it('keeps what is set, replaces it and forgets it once deleted', async () => {
    expect.hasAssertions()
    const store = new InMemorySecretStore()
    await expect(store.get('key')).resolves.toBeUndefined()
    await store.set('key', 'first')
    await expect(store.get('key')).resolves.toBe('first')
    await store.set('key', 'second')
    await expect(store.get('key')).resolves.toBe('second')
    await store.delete('key')
    await expect(store.get('key')).resolves.toBeUndefined()
  })
})
