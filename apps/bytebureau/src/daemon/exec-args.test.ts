import { describe, expect, it } from 'vitest'
import { daemonExecArgs } from './exec-args.js'

const BINARY = '/opt/bytebureau'
const BUN = '/usr/bin/bun'
const ENTRY = '/repo/apps/bytebureau/src/main.ts'

describe(daemonExecArgs, () => {
  it('runs the compiled binary itself with serve --no-daemonize and the flags', () => {
    expect(
      daemonExecArgs({ execPath: BINARY, argv: [BINARY, 'serve'] }, ['--port', '4747']),
    ).toStrictEqual({ command: BINARY, args: ['serve', '--no-daemonize', '--port', '4747'] })
    // As Bun 1.4.2 lays out the arguments of a compiled binary: a virtual path stands where a script would
    expect(
      daemonExecArgs({ execPath: BINARY, argv: ['bun', '/$bunfs/root/bytebureau', 'serve'] }, []),
    ).toStrictEqual({ command: BINARY, args: ['serve', '--no-daemonize'] })
  })

  it('runs the source through bun when the CLI runs from a .ts entry', () => {
    expect(daemonExecArgs({ execPath: BUN, argv: [BUN, ENTRY, 'serve'] }, [])).toStrictEqual({
      command: BUN,
      args: ['run', ENTRY, 'serve', '--no-daemonize'],
    })
  })
})
