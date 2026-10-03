import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createKernelFrom, type KernelOptions } from '../facade.js'
import { KernelTest } from '../kernel-test.js'
import { kernelLogger } from '../logging/logging.js'
import { tempDir } from '../testing/temp-repo.js'

const probe = kernelLogger(['bb', 'probe'])

interface Opened {
  readonly env?: KernelOptions['env']
  readonly userFile?: unknown
  readonly level?: string
}

// Whether a debug record of the probe reaches stderr once a kernel has started with the environment, the user file and the flag
async function debugReaches({ env = {}, userFile, level }: Opened): Promise<boolean> {
  const home = tempDir('bb-home-')
  if (userFile !== undefined) {
    writeFileSync(path.join(home, 'config.json'), JSON.stringify(userFile))
  }
  const written = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  onTestFinished(() => {
    written.mockRestore()
  })
  const logging = { json: true, ...(level === undefined ? {} : { level }) }
  const kernel = await createKernelFrom(KernelTest({ home }), { home, env, logging })
  onTestFinished(async () => {
    await kernel.close()
  })
  probe.debug('probe debug')
  return written.mock.calls.some((call) => String(call[0]).includes('probe debug'))
}

describe('the log level of a kernel without a --log-level flag', () => {
  it('comes from BYTEBUREAU_LOG_LEVEL', async () => {
    expect.hasAssertions()
    await expect(debugReaches({ env: { BYTEBUREAU_LOG_LEVEL: 'debug' } })).resolves.toBe(true)
  })

  it('comes from the logging section of the user file', async () => {
    expect.hasAssertions()
    await expect(debugReaches({ userFile: { logging: { level: 'debug' } } })).resolves.toBe(true)
  })

  it('is info when neither says anything, or the user file cannot be read', async () => {
    expect.hasAssertions()
    await expect(debugReaches({})).resolves.toBe(false)
    await expect(debugReaches({ userFile: { logging: { level: 'loud' } } })).resolves.toBe(false)
  })
})

describe('the --log-level flag', () => {
  it('wins over the environment and the user file', async () => {
    expect.hasAssertions()
    const both = {
      env: { BYTEBUREAU_LOG_LEVEL: 'debug' },
      userFile: { logging: { level: 'debug' } },
    }
    await expect(debugReaches({ ...both, level: 'info' })).resolves.toBe(false)
  })
})
