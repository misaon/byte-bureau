import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it, onTestFinished } from 'vitest'
import { endProcess } from './kill-ladder.js'
import type { Exit } from './process.js'
import { exitOf } from './testing/session-harness.js'

const STEP_MS = 300

// A node process that ignores the signals named, started and listening for them
const running = async (
  ...ignored: readonly string[]
): Promise<{ readonly child: ReturnType<typeof spawn>; readonly exited: Promise<Exit> }> => {
  const handlers = ignored.map((signal) => `process.on('${signal}', () => {});`).join(' ')
  const script = `${handlers} setInterval(() => {}, 1000); console.log('ready')`
  const child = spawn(process.execPath, ['-e', script])
  onTestFinished(() => {
    child.kill('SIGKILL')
  })
  const exited = exitOf(child)
  await once(child.stdout, 'data')
  return { child, exited }
}

describe('the kill ladder', () => {
  it('ends an agent with SIGINT when it heeds it', async () => {
    expect.hasAssertions()
    const { child, exited } = await running()
    await expect(endProcess(child, exited, STEP_MS)).resolves.toStrictEqual({
      code: null,
      signal: 'SIGINT',
    })
  })

  it('climbs to SIGTERM, then to SIGKILL, for an agent that ignores what came before', async () => {
    expect.hasAssertions()
    const polite = await running('SIGINT')
    await expect(endProcess(polite.child, polite.exited, STEP_MS)).resolves.toStrictEqual({
      code: null,
      signal: 'SIGTERM',
    })
    const stubborn = await running('SIGINT', 'SIGTERM')
    await expect(endProcess(stubborn.child, stubborn.exited, STEP_MS)).resolves.toStrictEqual({
      code: null,
      signal: 'SIGKILL',
    })
  })

  it('signals nothing to an agent that has already ended, and tells its exit', async () => {
    expect.hasAssertions()
    const { child, exited } = await running()
    child.kill('SIGTERM')
    await exited
    await expect(endProcess(child, exited, STEP_MS)).resolves.toStrictEqual({
      code: null,
      signal: 'SIGTERM',
    })
  })
})
