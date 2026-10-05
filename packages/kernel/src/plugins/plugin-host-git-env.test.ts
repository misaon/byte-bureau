import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { assert, it } from '@effect/vitest'
import { Effect, type Scope } from 'effect'
import { kernelLogger } from '../logging/logging.js'
import { withEnv } from '../process/supervisor-fixtures.js'
import { createTempRepo, tempDir } from '../testing/temp-repo.js'
import {
  destroyOn,
  provisionOn,
  runtimeFor,
  WorkspaceRuntimes,
  type WorkspaceRuntimesShape,
} from '../workspace/runtimes.js'
import { hostOver, loadedHost } from './plugin-fixtures.js'

// Real git processes, so the supervisor runs on the real clock
const live = { excludeTestServices: true }

const realGit = (): string => {
  const directories = (process.env['PATH'] ?? '').split(path.delimiter)
  const found = directories
    .map((directory) => path.join(directory, 'git'))
    .find((candidate) => existsSync(candidate))
  if (found === undefined) {
    throw new Error('git is not on PATH')
  }
  return found
}

// A git first on PATH that writes down the GIT_TERMINAL_PROMPT it was given, then runs the real one
const recordingGit = (log: string): string => {
  const directory = tempDir('bb-git-')
  const wrapper = path.join(directory, 'git')
  const script = `#!/bin/sh\nprintf '%s\\n' "\${GIT_TERMINAL_PROMPT-unset}" >> '${log}'\nexec '${realGit()}' "$@"\n`
  writeFileSync(wrapper, script)
  chmodSync(wrapper, 0o755)
  return directory
}

// The daemon's own GIT_TERMINAL_PROMPT asks for prompts, and every git it runs is written down
const onRecordingGit = (log: string): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* recordsGit() {
    yield* withEnv('HOME', tempDir('bb-home-'))
    yield* withEnv('PATH', `${recordingGit(log)}${path.delimiter}${process.env['PATH'] ?? ''}`)
    yield* withEnv('GIT_TERMINAL_PROMPT', '1')
  })

// A worktree of the repository provisioned and destroyed by the bundled local runtime
const provisionedAndDestroyed = (
  runtimes: WorkspaceRuntimesShape,
  repo: string,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* managesWorktree() {
    const runtime = yield* runtimeFor(runtimes, 'local')
    const logger = kernelLogger(['bb', 'test'])
    const spec = { sessionId: 'git-env-1', projectPath: repo, baseBranch: 'main', logger }
    const handle = yield* provisionOn(runtime, { ...spec, branch: 'bb/git-env-1', copyIgnored: [] })
    yield* destroyOn(runtime, handle, {})
  })

it.layer(hostOver(), live)('PluginHost process port and the git of the local runtime', (suite) => {
  suite.effect(
    "hands every git the GIT_TERMINAL_PROMPT=0 the runtime declares, over the daemon's own",
    () =>
      Effect.gen(function* passesPromptSetting() {
        const repo = createTempRepo()
        const log = path.join(tempDir('bb-git-log-'), 'prompts')
        yield* onRecordingGit(log)
        yield* loadedHost
        yield* provisionedAndDestroyed(yield* WorkspaceRuntimes, repo)
        const prompts = readFileSync(log, 'utf8').trim().split('\n')
        assert.isAbove(prompts.length, 0)
        assert.deepStrictEqual([...new Set(prompts)], ['0'])
      }),
  )
})
