import { fileURLToPath } from 'node:url'
import type { FakeScript } from './fake-acp-agent.js'

// The fake agent as a custom preset: the runtime of the tests runs the TypeScript file itself (Node strips the types, Bun runs it as it is)
export const fakeAgentCommand = (
  script: FakeScript,
): {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
} => ({
  command: process.execPath,
  args: [fileURLToPath(new URL('fake-acp-agent.ts', import.meta.url))],
  env: { BYTEBUREAU_FAKE_ACP_SCRIPT: script },
})
