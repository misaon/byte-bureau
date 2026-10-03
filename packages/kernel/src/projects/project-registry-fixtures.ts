import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Effect, Layer } from 'effect'
import { vi } from 'vitest'
import { ConfigLive } from '../config/config.js'
import { EventLogLive } from '../events/event-log.js'
import { StoreTest } from '../store/store-test.js'
import { createTempRepo, git } from '../testing/temp-repo.js'
import { ProjectRegistryLive, type ProjectRegistryShape } from './project-registry.js'

// An empty home directory for the user configuration, removed when the layer is released
export const emptyHome = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(path.join(tmpdir(), 'bb-home-'))),
  (home) =>
    Effect.sync(() => {
      rmSync(home, { recursive: true, force: true })
    }),
)

const services = Layer.unwrap(
  emptyHome.pipe(
    Effect.map((home) => {
      const config = ConfigLive(home)
      return Layer.mergeAll(EventLogLive, config)
    }),
  ),
)

export const TestLayer = ProjectRegistryLive.pipe(
  Layer.provideMerge(services),
  Layer.provideMerge(StoreTest),
)

// The project file of a fixture repository, with only the project section the test cares about
export function writeProjectFile(repo: string, project: Record<string, unknown>): void {
  const config = { version: 1, project, employees: {} }
  writeFileSync(path.join(repo, 'bytebureau.json'), JSON.stringify(config))
}

export function namedRepo(name: string): string {
  const repo = createTempRepo()
  writeProjectFile(repo, { name })
  return repo
}

// A repository whose remote HEAD names develop
export function trackingDevelop(): string {
  const repo = createTempRepo({ withRemote: true })
  git(repo, 'push', '-q', 'origin', 'main:refs/heads/develop')
  git(repo, 'remote', 'set-head', 'origin', 'develop')
  return repo
}

// Registers with the system clock stopped at the given instant, and lets it run again afterwards
export function registerAt(
  registry: ProjectRegistryShape,
  directory: string,
  instant: string,
): ReturnType<ProjectRegistryShape['register']> {
  return Effect.suspend(() => {
    vi.setSystemTime(instant)
    return registry.register(directory)
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        vi.useRealTimers()
      }),
    ),
  )
}
