import { describe, expect, it } from 'vitest'
import { refusingStub } from '../testing/health-stub.js'
import { runCli } from '../testing/run-cli.js'
import { testHome } from '../testing/temp-repo.js'

// Every command that talks to a daemon, run aside: it has exit codes of its own
const COMMANDS: readonly (readonly [string, readonly string[]])[] = [
  ['projects ls', ['projects', 'ls']],
  ['projects add', ['projects', 'add', 'somewhere']],
  ['projects rm', ['projects', 'rm', 'p1']],
  ['workspaces ls', ['workspaces', 'ls']],
  ['workspaces prune', ['workspaces', 'prune']],
  ['sessions ls', ['sessions', 'ls']],
  ['sessions show', ['sessions', 'show', 's1']],
  ['sessions interrupt', ['sessions', 'interrupt', 's1']],
  ['sessions stop', ['sessions', 'stop', 's1']],
  ['sessions resume', ['sessions', 'resume', 's1']],
  ['sessions prompt', ['sessions', 'prompt', 's1', 'go']],
  ['ask ls', ['ask', 'ls']],
  ['ask answer', ['ask', 'answer', 'a1', '--yes']],
  ['plugins ls', ['plugins', 'ls']],
  ['the bare status', []],
]

describe('a request that the daemon refuses with a 4xx problem', () => {
  it.each(COMMANDS)(
    'ends %s with exit code 1 and the detail of the problem',
    async (_name, command) => {
      expect.hasAssertions()
      const port = await refusingStub(409, 'locked', 'the daemon says no')
      const daemon = ['--host', '127.0.0.1', '--port', String(port)]
      const refused = await runCli([...command, ...daemon], { BYTEBUREAU_HOME: testHome() })
      expect([refused.code, refused.stderr.trim()]).toStrictEqual([1, 'the daemon says no'])
    },
  )
})
