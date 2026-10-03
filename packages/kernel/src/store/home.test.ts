import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../testing/temp-repo.js'
import { prepareHome, restrictDatabase } from './home.js'

const modeOf = (file: string): number => statSync(file).mode % 0o1000

// A chmod the system refuses, as it does for a file of another user
function refused(file: string): never {
  throw Object.assign(new Error(`EPERM: operation not permitted, chmod '${file}'`), {
    code: 'EPERM',
  })
}

describe(prepareHome, () => {
  it('creates the home and its data directory for the user alone', () => {
    const home = path.join(tempDir('bb-root-'), 'nested', 'home')
    const prepared = prepareHome(home)
    expect([prepared, modeOf(home), modeOf(prepared.data)]).toStrictEqual([
      { data: path.join(home, 'data'), warnings: [] },
      0o700,
      0o700,
    ])
  })

  it('leaves the modes of a home and a data directory that exist already', () => {
    const home = tempDir('bb-home-')
    const data = path.join(home, 'data')
    chmodSync(home, 0o755)
    mkdirSync(data, { mode: 0o755 })
    chmodSync(data, 0o755)
    prepareHome(home)
    expect([modeOf(home), modeOf(data)]).toStrictEqual([0o755, 0o755])
  })

  it('creates the data directory of an existing home for the user alone', () => {
    const home = tempDir('bb-home-')
    chmodSync(home, 0o755)
    const { data } = prepareHome(home)
    expect([modeOf(home), modeOf(data)]).toStrictEqual([0o755, 0o700])
  })

  it('reports a mode the system refuses to set as a warning and goes on', () => {
    const home = path.join(tempDir('bb-root-'), 'home')
    const { data, warnings } = prepareHome(home, refused)
    expect(existsSync(data)).toBe(true)
    expect(warnings).toStrictEqual([
      `${home} could not be made private to its user: EPERM: operation not permitted, chmod '${home}'`,
      `${data} could not be made private to its user: EPERM: operation not permitted, chmod '${data}'`,
    ])
  })
})

describe(restrictDatabase, () => {
  it('narrows the database, its WAL and its shared memory to the user, and passes over a missing one', () => {
    const data = tempDir('bb-data-')
    const database = path.join(data, 'bytebureau.db')
    for (const file of [database, `${database}-wal`]) {
      writeFileSync(file, '', { mode: 0o644 })
    }
    const warnings = restrictDatabase(database)
    expect([warnings, modeOf(database), modeOf(`${database}-wal`)]).toStrictEqual([
      [],
      0o600,
      0o600,
    ])
  })

  it('reports every database file the system refuses to narrow as a warning', () => {
    const database = path.join(tempDir('bb-data-'), 'bytebureau.db')
    const warnings = restrictDatabase(database, refused)
    expect(warnings.map((warning) => warning.split(' ')[0])).toStrictEqual([
      database,
      `${database}-wal`,
      `${database}-shm`,
    ])
  })
})
