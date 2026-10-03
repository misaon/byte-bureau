import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { eventLines, jsonLines } from '../testing/json-lines.js'
import { runCli } from '../testing/run-cli.js'
import { FAKE, PROMPT, workbench, type Workbench } from '../testing/workbench.js'

// The levels of the log records a run wrote to stderr, where every record goes
function logLevels(stderr: string): readonly unknown[] {
  return stderr.trim() === '' ? [] : jsonLines(stderr).map((line) => line['level'])
}

async function fakeRunWith(
  { repo, home }: Workbench,
  flags: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const result = await runCli(['run', PROMPT, '--project', repo, ...FAKE, ...flags], {
    BYTEBUREAU_HOME: home,
    ...env,
  })
  return result
}

describe('bytebureau run --json --debug', () => {
  it('keeps stdout pure NDJSON, every line an event with a seq, and logs on stderr', async () => {
    expect.hasAssertions()
    const result = await fakeRunWith(workbench(), ['--debug'])
    expect(result.code).toBe(0)
    const events = eventLines(result.stdout)
    expect(events.at(-1)).toMatchObject({ type: 'session.completed' })
    expect(events.every((event) => event.seq > 0)).toBe(true)
    expect(logLevels(result.stderr)).toContain('DEBUG')
  })
})

describe('bytebureau run log level', () => {
  it('logs at debug when BYTEBUREAU_LOG_LEVEL says so, and not otherwise', async () => {
    expect.hasAssertions()
    const quiet = await fakeRunWith(workbench(), [])
    const loud = await fakeRunWith(workbench(), [], { BYTEBUREAU_LOG_LEVEL: 'debug' })
    expect(logLevels(quiet.stderr)).not.toContain('DEBUG')
    expect(logLevels(loud.stderr)).toContain('DEBUG')
  })

  it('logs at debug when the user file says so, and the --log-level flag wins over both', async () => {
    expect.hasAssertions()
    const bench = workbench()
    writeFileSync(
      path.join(bench.home, 'config.json'),
      JSON.stringify({ logging: { level: 'debug' } }),
    )
    const byFile = await fakeRunWith(bench, [])
    const byFlag = await fakeRunWith(bench, ['--log-level', 'warn'], {
      BYTEBUREAU_LOG_LEVEL: 'debug',
    })
    expect(logLevels(byFile.stderr)).toContain('DEBUG')
    expect(logLevels(byFlag.stderr)).not.toContain('DEBUG')
  })
})

const modeOf = (file: string): number => statSync(file).mode % 0o1000

describe('the home of the kernel', () => {
  it('keeps the data directory and the database to the user', async () => {
    expect.hasAssertions()
    const bench = workbench()
    await fakeRunWith(bench, [])
    const data = path.join(bench.home, 'data')
    const database = path.join(data, 'bytebureau.db')
    const sideFiles = [`${database}-wal`, `${database}-shm`].filter((file) => existsSync(file))
    expect([modeOf(data), modeOf(database)]).toStrictEqual([0o700, 0o600])
    expect(sideFiles.map((file) => modeOf(file))).toStrictEqual(sideFiles.map(() => 0o600))
  })

  it('leaves the mode of a data directory that exists already and still narrows the database', async () => {
    expect.hasAssertions()
    const bench = workbench()
    const data = path.join(bench.home, 'data')
    mkdirSync(data, { mode: 0o755 })
    chmodSync(data, 0o755)
    const result = await fakeRunWith(bench, [])
    expect(result.code).toBe(0)
    expect([modeOf(data), modeOf(path.join(data, 'bytebureau.db'))]).toStrictEqual([0o755, 0o600])
  })
})
