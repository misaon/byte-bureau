import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { configJsonSchema } from '@bytebureau/protocol'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../testing/temp-repo.js'
import { configReader } from './config-reader.js'

describe(configReader, () => {
  it('validates the files of a project and opens nothing of the home: no store, no data', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const project = tempDir('bb-project-')
    writeFileSync(path.join(project, 'bytebureau.json'), '{ "version": 2 }')
    const issues = await configReader(home, {}).validate(project)
    expect(issues.map((issue) => issue.pointer)).toContain('/version')
    expect(existsSync(path.join(home, 'data'))).toBe(false)
  })

  it('takes the environment layer, so an issue can name the variable it comes from', async () => {
    expect.hasAssertions()
    const env = { BYTEBUREAU_LOG_LEVEL: 'loud' }
    const issues = await configReader(tempDir('bb-home-'), env).validate(tempDir('bb-project-'))
    expect(issues.map((issue) => issue.file)).toContain('env:BYTEBUREAU_LOG_LEVEL')
  })

  it('gives the JSON Schema of the project file', () => {
    expect(configReader(tempDir('bb-home-'), {}).schema()).toStrictEqual(configJsonSchema())
  })
})
