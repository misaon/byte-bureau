import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createKernelFrom, type KernelOptions } from './facade.js'
import { KernelTest } from './kernel-test.js'
import { kernelLogger } from './logging/logging.js'
import { tempDir } from './testing/temp-repo.js'

const probe = kernelLogger(['bb', 'probe'])

// What the kernel writes to stderr from here on, where every log record goes, kept from printing for the rest of the test
function stderrLines(): () => readonly string[] {
  const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  onTestFinished(() => {
    spy.mockRestore()
  })
  return () => spy.mock.calls.map((call) => String(call[0]))
}

// A kernel opened with the logging, which the process is configured with; the console shows what is logged afterwards
async function openLogging(logging?: KernelOptions['logging']): Promise<void> {
  const home = tempDir('bb-home-')
  const kernel = await createKernelFrom(KernelTest({ home }), { home, env: {}, logging })
  onTestFinished(async () => {
    await kernel.close()
  })
}

describe('the logging of the facade', () => {
  it('logs from the level it is given on, as JSON lines when asked to', async () => {
    expect.hasAssertions()
    const written = stderrLines()
    await openLogging({ level: 'debug', json: true })
    probe.debug('probe debug')
    const lines = written().filter((line) => line.includes('probe'))
    expect(lines).toStrictEqual([expect.stringContaining('probe debug')])
    expect(JSON.parse(lines.join(''))).toMatchObject({ level: 'DEBUG', message: 'probe debug' })
  })

  it('prints text, not JSON lines, when told not to use them', async () => {
    expect.hasAssertions()
    const written = stderrLines()
    await openLogging({ level: 'debug', json: false })
    probe.debug('probe text')
    const lines = written().filter((line) => line.includes('probe'))
    expect(lines).toStrictEqual([expect.stringContaining('probe text')])
    expect(lines.join('')).not.toMatch(/^\{/u)
  })

  it('logs from info on when it is given no logging at all', async () => {
    expect.hasAssertions()
    const written = stderrLines()
    await openLogging()
    probe.debug('below info')
    probe.info('at info')
    expect(written().filter((line) => line.includes('info'))).toStrictEqual([
      expect.stringContaining('at info'),
    ])
  })

  it('debugs the categories it is told to, whatever the level', async () => {
    expect.hasAssertions()
    const written = stderrLines()
    await openLogging({ level: 'error', json: true, debug: 'bb.probe' })
    probe.debug('selected')
    kernelLogger(['bb', 'other']).debug('not selected')
    expect(written().filter((line) => line.includes('selected'))).toStrictEqual([
      expect.stringContaining('"selected"'),
    ])
  })
})
