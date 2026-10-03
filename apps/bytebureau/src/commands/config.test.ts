import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { jsonLines } from '../testing/json-lines.js'
import { runCli } from '../testing/run-cli.js'
import { tempDir } from '../testing/temp-repo.js'

const JSONC = 'bytebureau.jsonc'

interface FreshProject {
  readonly project: string
  readonly home: string
  readonly env: Record<string, string>
}

function inFreshProject(): FreshProject {
  const home = tempDir('bb-home-')
  return { project: tempDir('bb-config-'), home, env: { BYTEBUREAU_HOME: home } }
}

describe('bytebureau config init', () => {
  it('writes a commented bytebureau.jsonc with the default employee, and says where', async () => {
    expect.hasAssertions()
    const { project, env } = inFreshProject()
    const result = await runCli(['config', 'init', '--project', project], env)
    const file = path.join(project, JSONC)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(`Wrote ${file}`)
    const written = readFileSync(file, 'utf8')
    expect(written).toContain('"developer"')
    expect(written).toContain('// Project identity')
  })

  it('reports the file as a JSON record with --json', async () => {
    expect.hasAssertions()
    const { project, env } = inFreshProject()
    const result = await runCli(['config', 'init', '--project', project, '--json'], env)
    expect(jsonLines(result.stdout)).toStrictEqual([
      { command: 'config.init', file: path.join(project, JSONC) },
    ])
  })

  it('exits 1 and leaves the file alone when the project has a configuration already', async () => {
    expect.hasAssertions()
    const { project, env } = inFreshProject()
    await runCli(['config', 'init', '--project', project], env)
    const file = path.join(project, JSONC)
    writeFileSync(file, '{ "kept": true }\n')
    const again = await runCli(['config', 'init', '--project', project], env)
    expect(again.code).toBe(1)
    expect(again.stderr.trim()).toBe(`${file} already exists`)
    expect(readFileSync(file, 'utf8')).toBe('{ "kept": true }\n')
  })

  it('does not add a bytebureau.jsonc next to a bytebureau.json: the kernel refuses a directory with both', async () => {
    expect.hasAssertions()
    const { project, env } = inFreshProject()
    const existing = path.join(project, 'bytebureau.json')
    writeFileSync(existing, '{}\n')
    const result = await runCli(['config', 'init', '--project', project], env)
    expect(result.code).toBe(1)
    expect(result.stderr.trim()).toBe(`${existing} already exists`)
    expect(existsSync(path.join(project, JSONC))).toBe(false)
  })
})

describe('bytebureau config init creates the file only when nothing is there', () => {
  it('does not write through a link that is in the way, and says that the file exists', async () => {
    expect.hasAssertions()
    const { project, env } = inFreshProject()
    const elsewhere = path.join(project, 'elsewhere.txt')
    const file = path.join(project, JSONC)
    symlinkSync(elsewhere, file)
    const result = await runCli(['config', 'init', '--project', project], env)
    expect(result.code).toBe(1)
    expect(result.stderr.trim()).toBe(`${file} already exists`)
    expect(existsSync(elsewhere)).toBe(false)
  })
})

describe('bytebureau config validate', () => {
  it('accepts the configuration that config init writes', async () => {
    expect.hasAssertions()
    const { project, env } = inFreshProject()
    await runCli(['config', 'init', '--project', project], env)
    const result = await runCli(['config', 'validate', '--project', project], env)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('Configuration is valid')
  })

  it('names the file and the JSON pointer of every problem, and exits 1', async () => {
    expect.hasAssertions()
    const { project, env } = inFreshProject()
    const file = path.join(project, 'bytebureau.json')
    writeFileSync(file, '{ "version": 1, "project": { "name": "x" }, "employees": {}, "nope": 1 }')
    const result = await runCli(['config', 'validate', '--project', project], env)
    expect(result.code).toBe(1)
    expect(result.stdout).toContain(`${file}/nope: `)
    expect(result.stderr.trim()).toBe('1 problem(s) found')
  })

  it('names the problems of the user configuration file as well', async () => {
    expect.hasAssertions()
    const { project, home, env } = inFreshProject()
    const userFile = path.join(home, 'config.json')
    writeFileSync(userFile, '{ "nope": 1 }')
    const result = await runCli(['config', 'validate', '--project', project], env)
    expect(result.code).toBe(1)
    expect(result.stdout).toContain(`${userFile}/nope: `)
  })

  it('reports the issues as one JSON record with --json', async () => {
    expect.hasAssertions()
    const { project, env } = inFreshProject()
    writeFileSync(path.join(project, 'bytebureau.json'), '{ "version": 2 }')
    const result = await runCli(['config', 'validate', '--project', project, '--json'], env)
    expect(result.code).toBe(1)
    const [record = {}] = jsonLines(result.stdout)
    expect(record).toMatchObject({ command: 'config.validate' })
    expect(record['issues']).toBeInstanceOf(Array)
  })
})

describe('bytebureau config schema', () => {
  it('prints the JSON Schema of bytebureau.json', async () => {
    expect.hasAssertions()
    const { env } = inFreshProject()
    const result = await runCli(['config', 'schema'], env)
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      $id: 'https://bytebureau.dev/schema/v1/config.json',
      type: 'object',
    })
  })
})
