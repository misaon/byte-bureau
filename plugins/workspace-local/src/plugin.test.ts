import { describe, expect, it } from 'vitest'
import pkg from '../package.json' with { type: 'json' }
import { localWorkspacePlugin } from './plugin.js'
import { pluginContext, soleRuntime, spySpawner, workspaceSpec } from './testing/fixtures.js'
import { createTempRepo } from './testing/temp-repo.js'

describe('workspace-local plugin', () => {
  it('declares in its manifest what its package declares', () => {
    expect(localWorkspacePlugin.manifest).toMatchObject(pkg.bytebureau)
  })

  it('registers the local runtime on the process spawner of its context', async () => {
    expect.hasAssertions()
    const { spawner, calls } = spySpawner()
    const runtime = soleRuntime(await localWorkspacePlugin.setup(pluginContext(spawner)))
    expect(runtime).toMatchObject({ id: 'local', isolation: 'none' })
    await runtime.provision(workspaceSpec(createTempRepo()))
    expect(calls.length).toBeGreaterThan(0)
  })
})
