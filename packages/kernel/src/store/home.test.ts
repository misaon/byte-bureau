import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../testing/temp-repo.js'
import { prepareHome, restrictDatabase } from './home.js'

const modeOf = (file: string): number => statSync(file).mode % 0o1000

describe(prepareHome, () => {
  it('creates the home and its data directory for the user alone', () => {
    const home = path.join(tempDir('bb-root-'), 'nested', 'home')
    const data = prepareHome(home)
    expect([data, modeOf(home), modeOf(data)]).toStrictEqual([
      path.join(home, 'data'),
      0o700,
      0o700,
    ])
  })

  it('narrows a data directory that exists already, and leaves the mode of an existing home', () => {
    const home = tempDir('bb-home-')
    const data = path.join(home, 'data')
    chmodSync(home, 0o755)
    mkdirSync(data, { mode: 0o755 })
    chmodSync(data, 0o755)
    prepareHome(home)
    expect([modeOf(home), modeOf(data)]).toStrictEqual([0o755, 0o700])
  })
})

describe(restrictDatabase, () => {
  it('narrows the database, its WAL and its shared memory to the user, and passes over a missing one', () => {
    const data = tempDir('bb-data-')
    const database = path.join(data, 'bytebureau.db')
    for (const file of [database, `${database}-wal`]) {
      writeFileSync(file, '', { mode: 0o644 })
    }
    restrictDatabase(database)
    expect([modeOf(database), modeOf(`${database}-wal`)]).toStrictEqual([0o600, 0o600])
  })
})
