import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { atTheTerminal, cleanedUp, started, type Throwaway } from './smoke-cli.js'

// A directory under the temporary one, removed with the test should the code under test leave it
const ROOT = realpathSync(tmpdir())

const madeDir = (): string => {
  const made = mkdtempSync(path.join(ROOT, 'bb-smoke-test-'))
  onTestFinished(() => {
    rmSync(made, { recursive: true, force: true })
  })
  return made
}

// A smoke on its own throwaway home, its commands run on the home the environment names
const smokeOn = (home: string, value: string, received = false): Throwaway => ({
  home,
  repo: madeDir(),
  env: { BYTEBUREAU_HOME: value },
  stopping: { received },
  running: new Set(),
})

describe(cleanedUp, () => {
  it('tells a step that fails instead of throwing, and still removes the home and the repository', async () => {
    expect.hasAssertions()
    const told = vi.spyOn(console, 'error').mockReturnValue()
    const home = madeDir()
    const other = madeDir()
    const smoke = smokeOn(home, other)
    await expect(cleanedUp(smoke)).resolves.toBeUndefined()
    expect(told.mock.calls.map(([line]) => String(line))).toStrictEqual([
      `smoke: serve --stop failed: refusing to run bytebureau serve --stop --json on ${other}`,
      'smoke: the home and the repository are gone',
    ])
    expect([existsSync(home), existsSync(smoke.repo)]).toStrictEqual([false, false])
  })
})

describe('a command of a smoke a signal has stopped', () => {
  it('is not run, and ends with 130 as a command a SIGINT ended does', async () => {
    expect.hasAssertions()
    const home = madeDir()
    const stopped = smokeOn(home, home, true)
    await expect(started(stopped, ['run', 'x']).done).resolves.toStrictEqual({
      code: 130,
      records: [],
    })
    await expect(atTheTerminal(stopped, ['profiles', 'add', 'fake', 'work'])).resolves.toBe(130)
  })
})
