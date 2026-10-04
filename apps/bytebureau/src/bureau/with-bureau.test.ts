import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createContext, type Context } from '../context.js'
import { writeServerInfo } from '../daemon/server-info.js'
import { healthStub, projectsStub, recordOn } from '../testing/health-stub.js'
import { testHome } from '../testing/temp-repo.js'
import type { Bureau } from './bureau.js'
import { DaemonRunningError } from './open-local.js'
import { withBureau } from './with-bureau.js'

// The context of a command on the home: never the home of the person who runs the tests
const contextIn = (home: string): Context =>
  createContext({ json: false, color: false, yes: false }, { BYTEBUREAU_HOME: home }, false)

// What a command learns of its Bureau: the projects, and where they come from
async function projectsIn(bureau: Bureau): Promise<unknown> {
  const projects = await bureau.projects.list()
  return { projects, where: bureau.where }
}

describe(withBureau, () => {
  it('refuses the kernel of this process while the daemon of the home answers, naming the daemon', async () => {
    expect.hasAssertions()
    const home = testHome()
    const port = await healthStub()
    writeServerInfo(home, recordOn(port))
    const work = vi.fn<(bureau: Bureau) => Promise<unknown>>()
    const refusal = `A daemon is running on http://127.0.0.1:${port} (pid ${process.pid}); drop --no-daemon or stop it with bytebureau serve --stop`
    await expect(withBureau(contextIn(home), { daemon: false }, work)).rejects.toThrow(
      new DaemonRunningError(refusal),
    )
    expect(work).not.toHaveBeenCalled()
  })

  it('talks to the daemon --host and --port name, with the token of --token-file', async () => {
    expect.hasAssertions()
    const home = testHome()
    const stub = await projectsStub()
    const tokenFile = path.join(home, 'token')
    writeFileSync(tokenFile, 'abc\n')
    const flags = { daemon: true, host: '127.0.0.1', port: stub.port, tokenFile }
    await expect(withBureau(contextIn(home), flags, projectsIn)).resolves.toStrictEqual({
      projects: [],
      where: { kind: 'daemon', url: `http://127.0.0.1:${stub.port}` },
    })
    expect(stub.authorizations()).toStrictEqual(['Bearer abc'])
  })

  it('talks to the daemon of the home once it answers, with the token of its record', async () => {
    expect.hasAssertions()
    const home = testHome()
    const stub = await projectsStub()
    writeServerInfo(home, recordOn(stub.port))
    await expect(withBureau(contextIn(home), { daemon: true }, projectsIn)).resolves.toMatchObject({
      projects: [],
    })
    expect(stub.authorizations()).toStrictEqual([`Bearer ${'a'.repeat(64)}`])
  })
})
