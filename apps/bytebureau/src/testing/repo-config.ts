import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The fake ACP agent of the agent-acp tests, a file its package does not export
const FAKE_ACP_AGENT = fileURLToPath(
  new URL('../../../../plugins/agent-acp/src/testing/fake-acp-agent.ts', import.meta.url),
)

export interface AcpPreset {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

// The project file of a test repository, as given: the kernel merges it over its defaults
export function writeConfig(repo: string, config: Readonly<Record<string, unknown>>): void {
  writeFileSync(path.join(repo, 'bytebureau.json'), JSON.stringify(config))
}

// An ACP preset that runs the fake ACP agent under Bun from PATH, playing the script its env names
export function fakeAcpPreset(script = 'hello'): AcpPreset {
  return { command: 'bun', args: [FAKE_ACP_AGENT], env: { BYTEBUREAU_FAKE_ACP_SCRIPT: script } }
}
