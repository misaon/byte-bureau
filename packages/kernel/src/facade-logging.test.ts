import { describe, expect, it, onTestFinished, vi, type MockInstance } from 'vitest'
import { createKernelFrom, type KernelOptions } from './facade.js'
import { KernelTest } from './kernel-test.js'
import { kernelLogger } from './logging/logging.js'
import { tempDir } from './testing/temp-repo.js'

const probe = kernelLogger(['bb', 'probe'])

// The console method, kept from printing for the rest of the test
function mute(method: 'debug' | 'info'): MockInstance {
  const spy = vi.spyOn(console, method).mockReturnValue()
  onTestFinished(() => {
    spy.mockRestore()
  })
  return spy
}

// What the console was given, as text
const linesOf = (spy: MockInstance): readonly string[] =>
  spy.mock.calls.map((call) => String(call[0]))

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
    const debug = mute('debug')
    await openLogging({ level: 'debug', json: true })
    probe.debug('probe debug')
    const lines = linesOf(debug)
    expect(lines).toStrictEqual([expect.stringContaining('probe debug')])
    expect(JSON.parse(lines.join(''))).toMatchObject({ level: 'DEBUG', message: 'probe debug' })
  })

  it('prints text, not JSON lines, when told not to use them', async () => {
    expect.hasAssertions()
    const debug = mute('debug')
    await openLogging({ level: 'debug', json: false })
    probe.debug('probe text')
    const lines = linesOf(debug)
    expect(lines).toStrictEqual([expect.stringContaining('probe text')])
    expect(lines.join('')).not.toMatch(/^\{/u)
  })

  it('logs from info on when it is given no logging at all', async () => {
    expect.hasAssertions()
    const [debug, info] = [mute('debug'), mute('info')]
    await openLogging()
    probe.debug('below info')
    probe.info('at info')
    expect(linesOf(debug)).toStrictEqual([])
    expect(linesOf(info)).toStrictEqual([expect.stringContaining('at info')])
  })

  it('debugs the categories it is told to, whatever the level', async () => {
    expect.hasAssertions()
    const debug = mute('debug')
    await openLogging({ level: 'error', json: true, debug: 'bb.probe' })
    probe.debug('selected')
    kernelLogger(['bb', 'other']).debug('not selected')
    expect(linesOf(debug)).toStrictEqual([expect.stringContaining('selected')])
  })
})
