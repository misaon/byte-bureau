import { existsSync } from 'node:fs'
import type { WorkspaceSpec } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { kernelLogger } from '../logging/logging.js'
import { withEnv } from '../process/supervisor-fixtures.js'
import { createTempRepo, tempDir } from '../testing/temp-repo.js'
import { WorkspaceRuntimes } from '../workspace/runtimes.js'
import { resolved } from './plugin-call-fixtures.js'
import { hostOver, loadedHost } from './plugin-fixtures.js'

// Real git processes, so the supervisor runs on the real clock
const live = { excludeTestServices: true }

const specFor = (projectPath: string): WorkspaceSpec => ({
  sessionId: 'host-1',
  projectPath,
  baseBranch: 'main',
  branch: 'bb/host-1',
  copyIgnored: [],
  logger: kernelLogger(['bb', 'test']),
})

it.layer(hostOver(), live)('PluginHost workspace runtime', (suite) => {
  suite.effect('lets the bundled runtime provision and destroy a worktree through the host', () =>
    Effect.gen(function* managesWorktree() {
      yield* withEnv('HOME', tempDir('bb-home-'))
      yield* loadedHost
      const runtime = yield* Effect.fromNullishOr((yield* WorkspaceRuntimes).get('local'))
      const repo = createTempRepo()
      const handle = yield* resolved(runtime.provision(specFor(repo)))
      assert.isTrue(existsSync(handle.path))
      assert.strictEqual(handle.branch, 'bb/host-1')
      assert.isFalse((yield* resolved(runtime.status(handle))).dirty)
      yield* resolved(runtime.destroy(handle))
      assert.isFalse(existsSync(handle.path))
    }),
  )
})
