import { describe, expect, it } from 'vitest'
import { refusingStub } from '../testing/health-stub.js'
import { runCli } from '../testing/run-cli.js'
import { createTempRepo, testHome, tokenFile } from '../testing/temp-repo.js'
import { PROMPT } from '../testing/workbench.js'

describe('bytebureau run and a daemon named on the command line that refuses its token', () => {
  it('tells where the token of that daemon goes, though the run fails with exit 2 and not as a refusal', async () => {
    expect.hasAssertions()
    const port = await refusingStub(401, 'unauthorized', 'a valid API token is required')
    const named = ['--host', '127.0.0.1', '--port', String(port), '--token-file', tokenFile()]
    const result = await runCli(['run', PROMPT, '--project', createTempRepo(), ...named], {
      BYTEBUREAU_HOME: testHome(),
    })
    expect([result.code, result.stderr.trim()]).toStrictEqual([
      2,
      'a valid API token is required (pass the token of that daemon with --token-file)',
    ])
  })
})
