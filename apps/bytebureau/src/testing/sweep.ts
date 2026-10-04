import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RUN_DIRECTORY, scratchOf, sweepHomes } from './sweep-homes.js'

// The global setup of the project: the workers inherit where the run writes its scratch homes down
export function setup(): void {
  process.env[RUN_DIRECTORY] = mkdtempSync(path.join(tmpdir(), 'bb-test-run-'))
}

// After the last test: no daemon of a scratch home outlives the run, whatever a test that timed out did after its cleanup
export async function teardown(): Promise<void> {
  const run = process.env[RUN_DIRECTORY]
  if (run === undefined) {
    return
  }
  const swept = await sweepHomes(scratchOf(run))
  if (swept.length > 0) {
    console.warn(`the sweep ended daemons that outlived their tests: ${swept.join(', ')}`)
  }
  rmSync(run, { recursive: true, force: true })
}
