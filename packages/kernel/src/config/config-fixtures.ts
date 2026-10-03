import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Effect, type Scope } from 'effect'
import { Config, ConfigLive, type ConfigShape } from './config.js'

export const PROJECT_FILE = 'bytebureau.json'
export const PROJECT_JSONC = 'bytebureau.jsonc'
export const LOCAL_FILE = 'bytebureau.local.json'
export const USER_FILE = 'config.json'

export interface Workspace {
  readonly config: ConfigShape
  readonly home: string
  readonly project: string
}

// Fixture directories are removed when the scope of their test closes
function tempDir(prefix: string): Effect.Effect<string, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), prefix))),
    (directory) =>
      Effect.sync(() => {
        rmSync(directory, { recursive: true, force: true })
      }),
  )
}

// Strings are written as they are, every other value as JSON
export function write(directory: string, name: string, content: unknown): string {
  const file = path.join(directory, name)
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  return file
}

// A Config over an empty home directory, next to an empty project directory
export function workspace(): Effect.Effect<Workspace, never, Scope.Scope> {
  return Effect.gen(function* emptyWorkspace() {
    const home = yield* tempDir('bb-home-')
    const project = yield* tempDir('bb-project-')
    const config = yield* Effect.provide(Config, ConfigLive(home))
    return { config, home, project }
  })
}
