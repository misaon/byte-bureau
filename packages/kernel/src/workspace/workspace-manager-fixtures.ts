import { LocalWorkspaceRuntime } from '@bytebureau/workspace-local'
import { Layer } from 'effect'
import { kernelLogger } from '../logging/logging.js'
import { TestLayer as RegistryLayer } from '../projects/project-registry-fixtures.js'
import { nodeSpawner } from '../testing/node-spawner.js'
import { WorkspaceRuntimes } from './runtimes.js'
import { WorkspaceManagerLive } from './workspace-manager.js'

const local = new LocalWorkspaceRuntime(nodeSpawner, kernelLogger(['bb', 'test']))

const runtimes = Layer.succeed(
  WorkspaceRuntimes,
  WorkspaceRuntimes.of({
    get: (id) => (id === local.id ? local : undefined),
    list: () => [local],
  }),
)

// The manager over the real local runtime, with the project registry, the event log and an in-memory store beside it
export const TestLayer = WorkspaceManagerLive.pipe(
  Layer.provideMerge(runtimes),
  Layer.provideMerge(RegistryLayer),
)
