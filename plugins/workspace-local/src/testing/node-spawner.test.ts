import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readLines } from './fixtures.js'
import { nodeSpawner } from './node-spawner.js'
import { tempDir } from './temp-repo.js'

const node = process.execPath
const cwd = process.cwd()

describe('node spawner', () => {
  it('runs a command and reports its lines and its exit code', async () => {
    expect.hasAssertions()
    const script = "console.log('out'); console.error('err'); process.exit(3)"
    const child = await nodeSpawner.spawn({ command: node, args: ['-e', script], cwd })
    const [stdout, stderr, exit] = await Promise.all([
      readLines(child.stdout),
      readLines(child.stderr),
      child.exited,
    ])
    expect({ stdout, stderr, exit }).toStrictEqual({
      stdout: ['out'],
      stderr: ['err'],
      exit: { code: 3, signal: null },
    })
  })

  it('reports a command that cannot start as exit -1 with the reason on stderr', async () => {
    expect.hasAssertions()
    const child = await nodeSpawner.spawn({ command: 'bb-no-such-command', args: [], cwd })
    const [stdout, stderr, exit] = await Promise.all([
      readLines(child.stdout),
      readLines(child.stderr),
      child.exited,
    ])
    expect(exit).toStrictEqual({ code: -1, signal: null })
    expect(stdout).toStrictEqual([])
    expect(stderr).toStrictEqual(['spawn bb-no-such-command ENOENT'])
  })

  it('reports a working directory that does not exist the same way', async () => {
    expect.hasAssertions()
    const missing = path.join(tempDir('bb-cwd-'), 'missing')
    const child = await nodeSpawner.spawn({ command: node, args: ['-e', '1'], cwd: missing })
    await expect(child.exited).resolves.toStrictEqual({ code: -1, signal: null })
    await expect(readLines(child.stderr)).resolves.toHaveLength(1)
  })
})

describe('node spawner process control', () => {
  it('reports a process that was aborted as killed by SIGTERM', async () => {
    expect.hasAssertions()
    const controller = new AbortController()
    const args = ['-e', 'setInterval(() => {}, 1000)']
    const child = await nodeSpawner.spawn({ command: node, args, cwd, signal: controller.signal })
    controller.abort()
    await expect(child.exited).resolves.toStrictEqual({ code: null, signal: 'SIGTERM' })
  })

  it('hides the global git configuration, unless the spec says otherwise', async () => {
    expect.hasAssertions()
    const args = [
      '-e',
      'console.log(process.env.GIT_CONFIG_GLOBAL, process.env.GIT_CONFIG_NOSYSTEM)',
    ]
    const plain = await nodeSpawner.spawn({ command: node, args, cwd })
    await expect(readLines(plain.stdout)).resolves.toStrictEqual(['/dev/null 1'])
    const env = { GIT_CONFIG_GLOBAL: 'x' }
    const custom = await nodeSpawner.spawn({ command: node, args, cwd, env })
    await expect(readLines(custom.stdout)).resolves.toStrictEqual(['x 1'])
  })
})
