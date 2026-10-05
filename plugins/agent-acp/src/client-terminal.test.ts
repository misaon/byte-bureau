import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Terminals } from './client-terminal.js'
import { tempDir } from './testing/requests.js'
import { harness } from './testing/session-harness.js'

const SESSION = 'fake-acp-1'
const node = process.execPath

// Terminals over the process port of the tests, in a workspace of their own, with a variable of the session
const terminalsIn = (): { readonly terminals: Terminals; readonly workspace: string } => {
  const workspace = path.join(tempDir('bb-acp-term-'), 'ws')
  mkdirSync(workspace)
  const { deps } = harness()
  const terminals = new Terminals(deps.process, workspace, { FROM_SESSION: 'session' })
  return { terminals, workspace }
}

const run = async (terminals: Terminals, script: string, extra = {}): Promise<string> => {
  const { terminalId } = await terminals.create({
    sessionId: SESSION,
    command: node,
    args: ['-e', script],
    ...extra,
  })
  return terminalId
}

// What a terminal that printed ok tells, under the output limit given
const okUnder = async (terminals: Terminals, outputByteLimit: number): Promise<unknown> => {
  const terminalId = await run(terminals, "console.log('ok')", { outputByteLimit })
  await terminals.waitForExit({ sessionId: SESSION, terminalId })
  return terminals.output({ sessionId: SESSION, terminalId })
}

describe('the output limit an agent asks for', () => {
  it('is taken in whole bytes, none below zero and 16 MiB at most, so no limit can stall the output', async () => {
    expect.hasAssertions()
    const { terminals } = terminalsIn()
    await expect(okUnder(terminals, -1)).resolves.toMatchObject({ output: '', truncated: true })
    await expect(okUnder(terminals, 0.5)).resolves.toMatchObject({ output: '', truncated: true })
    await expect(okUnder(terminals, 2.5)).resolves.toMatchObject({ output: 'k\n', truncated: true })
    await expect(okUnder(terminals, 1e15)).resolves.toMatchObject({
      output: 'ok\n',
      truncated: false,
    })
  })
})

describe('the output of a terminal', () => {
  it('keeps the newest output within the byte limit, at a character boundary, and says it cut', async () => {
    expect.hasAssertions()
    const { terminals } = terminalsIn()
    const script = "console.log('a'.repeat(100)); console.log('b'.repeat(10))"
    const terminalId = await run(terminals, script, { outputByteLimit: 16 })
    await terminals.waitForExit({ sessionId: SESSION, terminalId })
    expect(terminals.output({ sessionId: SESSION, terminalId })).toStrictEqual({
      output: `${'a'.repeat(4)}\n${'b'.repeat(10)}\n`,
      truncated: true,
      exitStatus: { exitCode: 0, signal: null },
    })
    const czech = await run(terminals, "console.log('žžž')", { outputByteLimit: 4 })
    await terminals.waitForExit({ sessionId: SESSION, terminalId: czech })
    expect(terminals.output({ sessionId: SESSION, terminalId: czech })).toMatchObject({
      output: 'ž\n',
      truncated: true,
    })
  })

  it('tells how a command exited, and has no exit status while it runs', async () => {
    expect.hasAssertions()
    const { terminals } = terminalsIn()
    const failing = await run(terminals, "console.log('bye'); process.exit(3)")
    const exit = { exitCode: 3, signal: null }
    await expect(
      terminals.waitForExit({ sessionId: SESSION, terminalId: failing }),
    ).resolves.toStrictEqual(exit)
    expect(terminals.output({ sessionId: SESSION, terminalId: failing })).toStrictEqual({
      output: 'bye\n',
      truncated: false,
      exitStatus: exit,
    })
    const running = await run(terminals, 'setInterval(() => {}, 1000)')
    expect(terminals.output({ sessionId: SESSION, terminalId: running })).toStrictEqual({
      output: '',
      truncated: false,
    })
    terminals.releaseAll()
  })
})

describe('the life of a terminal', () => {
  it('kills a command and keeps its terminal until it is released', async () => {
    expect.hasAssertions()
    const { terminals } = terminalsIn()
    const terminalId = await run(terminals, 'setInterval(() => {}, 1000)')
    expect(terminals.kill({ sessionId: SESSION, terminalId })).toStrictEqual({})
    await expect(terminals.waitForExit({ sessionId: SESSION, terminalId })).resolves.toStrictEqual({
      exitCode: null,
      signal: 'SIGTERM',
    })
    expect(terminals.release({ sessionId: SESSION, terminalId })).toStrictEqual({})
    expect(() => terminals.output({ sessionId: SESSION, terminalId })).toThrow(
      `Invalid params: no terminal ${terminalId}`,
    )
  })

  it('runs in the workspace with the environment of the session and of the agent, and nowhere outside', async () => {
    expect.hasAssertions()
    const { terminals, workspace } = terminalsIn()
    const script = 'console.log(process.cwd(), process.env.FROM_SESSION, process.env.FROM_AGENT)'
    const env = [{ name: 'FROM_AGENT', value: 'agent' }]
    const terminalId = await run(terminals, script, { env })
    await terminals.waitForExit({ sessionId: SESSION, terminalId })
    expect(terminals.output({ sessionId: SESSION, terminalId })).toMatchObject({
      output: `${workspace} session agent\n`,
    })
    const elsewhere = path.dirname(workspace)
    await expect(run(terminals, '1', { cwd: elsewhere })).rejects.toThrow(
      `Invalid params: ${elsewhere} is outside the workspace`,
    )
  })
})
