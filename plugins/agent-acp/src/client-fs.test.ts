import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { RequestError } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import { insideWorkspace, readTextFile, writeTextFile } from './client-fs.js'
import { tempDir } from './testing/requests.js'

const SESSION = 'fake-acp-1'

// A workspace with a sibling directory beside it, which is outside of it
const layout = (): { readonly workspace: string; readonly outside: string } => {
  const parent = tempDir('bb-acp-fs-')
  const workspace = path.join(parent, 'ws')
  const outside = path.join(parent, 'outside')
  mkdirSync(path.join(workspace, 'src'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(path.join(outside, 'secret.txt'), 'the outside secret')
  return { workspace, outside }
}

const outsideError = (target: string): RequestError =>
  new RequestError(-32_602, `Invalid params: ${target} is outside the workspace`, { path: target })

describe('the places inside the workspace', () => {
  it('holds its files, the ones not written yet, and itself, but nothing above it or beside it', () => {
    expect.hasAssertions()
    const { workspace, outside } = layout()
    const inside = ['src/a.ts', 'src/new/deep/b.ts', '.', 'src/../c.ts']
    expect(
      inside.map((file) => insideWorkspace(workspace, path.join(workspace, file))),
    ).toStrictEqual([true, true, true, true])
    const elsewhere = [
      `${workspace}/../outside/secret.txt`,
      outside,
      '/etc/hosts',
      `${workspace}-other/x`,
    ]
    expect(elsewhere.map((target) => insideWorkspace(workspace, target))).toStrictEqual([
      false,
      false,
      false,
      false,
    ])
  })
})

describe('the places a symlink in the workspace leads to', () => {
  it('follows a symlink to where it points, dangling or not, and judges that', () => {
    expect.hasAssertions()
    const { workspace, outside } = layout()
    symlinkSync(path.join(outside, 'secret.txt'), path.join(workspace, 'leak.txt'))
    symlinkSync(path.join(outside, 'not-yet.txt'), path.join(workspace, 'dangling.txt'))
    symlinkSync(outside, path.join(workspace, 'out'))
    symlinkSync(path.join(workspace, 'src'), path.join(workspace, 'sources'))
    // Joined by hand: path.join would take out/.. away before the file system could follow the link
    const files = [
      'leak.txt',
      'dangling.txt',
      'out/new.txt',
      'out/../outside/secret.txt',
      'sources/a.ts',
    ]
    const judged = files.map((file) => insideWorkspace(workspace, `${workspace}/${file}`))
    expect(judged).toStrictEqual([false, false, false, false, true])
  })

  it('refuses a path through links that never end', () => {
    expect.hasAssertions()
    const { workspace } = layout()
    symlinkSync(path.join(workspace, 'b'), path.join(workspace, 'a'))
    symlinkSync(path.join(workspace, 'a'), path.join(workspace, 'b'))
    expect(insideWorkspace(workspace, path.join(workspace, 'a', 'file.txt'))).toBe(false)
  })

  it('takes a relative path as one inside the workspace', () => {
    expect.hasAssertions()
    const { workspace } = layout()
    expect(insideWorkspace(workspace, 'src/a.ts')).toBe(true)
    expect(insideWorkspace(workspace, '../outside/secret.txt')).toBe(false)
  })
})

describe('the files an agent reads', () => {
  it('reads a file of the workspace, from a line and for a number of lines when asked', async () => {
    expect.hasAssertions()
    const { workspace } = layout()
    const file = path.join(workspace, 'src', 'lines.txt')
    writeFileSync(file, 'one\ntwo\nthree\nfour\n')
    await expect(
      readTextFile(workspace, { sessionId: SESSION, path: file }),
    ).resolves.toStrictEqual({ content: 'one\ntwo\nthree\nfour\n' })
    const window = { sessionId: SESSION, path: file, line: 2, limit: 2 }
    await expect(readTextFile(workspace, window)).resolves.toStrictEqual({ content: 'two\nthree' })
    const tail = { sessionId: SESSION, path: file, line: 3, limit: null }
    await expect(readTextFile(workspace, tail)).resolves.toStrictEqual({ content: 'three\nfour\n' })
  })

  it('refuses a file outside the workspace, or behind a symlink out of it, with invalid params', async () => {
    expect.hasAssertions()
    const { workspace, outside } = layout()
    const above = `${workspace}/../outside/secret.txt`
    await expect(
      readTextFile(workspace, { sessionId: SESSION, path: above }),
    ).rejects.toStrictEqual(outsideError(above))
    const link = path.join(workspace, 'leak.txt')
    symlinkSync(path.join(outside, 'secret.txt'), link)
    await expect(readTextFile(workspace, { sessionId: SESSION, path: link })).rejects.toThrow(
      `${link} is outside the workspace`,
    )
  })
})

describe('the files an agent writes', () => {
  it('writes a file of the workspace, making the directories it needs', async () => {
    expect.hasAssertions()
    const { workspace } = layout()
    const file = path.join(workspace, 'src', 'deep', 'er', 'hello.ts')
    const params = { sessionId: SESSION, path: file, content: 'export {}\n' }
    await expect(writeTextFile(workspace, params)).resolves.toStrictEqual({})
    expect(readFileSync(file, 'utf8')).toBe('export {}\n')
  })

  it('refuses to write outside the workspace, through a symlink too, and leaves the target as it was', async () => {
    expect.hasAssertions()
    const { workspace, outside } = layout()
    const target = path.join(outside, 'secret.txt')
    symlinkSync(target, path.join(workspace, 'leak.txt'))
    const throughLink = { sessionId: SESSION, path: path.join(workspace, 'leak.txt'), content: 'x' }
    await expect(writeTextFile(workspace, throughLink)).rejects.toThrow('is outside the workspace')
    const direct = { sessionId: SESSION, path: path.join(outside, 'new.txt'), content: 'x' }
    await expect(writeTextFile(workspace, direct)).rejects.toStrictEqual(outsideError(direct.path))
    expect(readFileSync(target, 'utf8')).toBe('the outside secret')
  })
})
