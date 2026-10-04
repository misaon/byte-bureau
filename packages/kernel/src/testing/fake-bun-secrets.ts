import { onTestFinished, vi } from 'vitest'

interface Entry {
  readonly service: string
  readonly name: string
  readonly value?: string
}

// How the keychain of a test behaves: it answers, refuses every write as a locked one does, or holds every write until released
export type FakeKeychain = 'answers' | 'refuses' | 'holds'

export interface FakeBun {
  // What the keychain holds now, by service/name
  readonly entries: Map<string, string>
  // Every service/name written so far, a held write included once it went through
  readonly written: readonly string[]
  // Lets the writes a holding keychain held go through
  readonly release: () => void
}

const keyOf = ({ service, name }: Entry): string => `${service}/${name}`

const restoredWithTheTest = (): void => {
  onTestFinished(() => {
    vi.unstubAllGlobals()
  })
}

// No Bun at all, as under Node, even when Vitest itself runs on Bun: nothing can reach a real keychain
export function withoutBun(): void {
  vi.stubGlobal('Bun', null)
  restoredWithTheTest()
}

// Bun.secrets as a map in place of the global Bun until the test ends; nothing of it reaches a real keychain
export function fakeBun(keychain: FakeKeychain): FakeBun {
  const entries = new Map<string, string>()
  const written: string[] = []
  const held = Promise.withResolvers<boolean>()
  const secrets = {
    get: async (entry: Entry): Promise<string | null> => {
      await Promise.resolve()
      return entries.get(keyOf(entry)) ?? null
    },
    set: async (entry: Entry): Promise<void> => {
      await (keychain === 'holds' ? held.promise : Promise.resolve())
      if (keychain === 'refuses') {
        throw new Error('the keychain is locked')
      }
      entries.set(keyOf(entry), entry.value ?? '')
      written.push(keyOf(entry))
    },
    delete: async (entry: Entry): Promise<boolean> => {
      await Promise.resolve()
      return entries.delete(keyOf(entry))
    },
  }
  vi.stubGlobal('Bun', { secrets })
  restoredWithTheTest()
  return {
    entries,
    written,
    release: () => {
      held.resolve(true)
    },
  }
}
