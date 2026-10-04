#!/usr/bin/env bun
import { runCommand, type CommandDef } from 'citty'
import { statusCommand } from './commands/status.js'
import { subCommands } from './commands/sub-commands.js'
import { globalArgs } from './context.js'
import { drained } from './drain.js'
import { run } from './run.js'
import { version } from './version.js'

// How the process ends: its exit code, and how long its output may take to drain; without a limit, as long as the reader takes
interface Ending {
  readonly code: number | string
  readonly drainLimitMs?: number | undefined
}

// A failure nobody caught ends the process with exit code 2 once the output is out, or a second later: the flow it broke may never finish
const { promise: uncaught, resolve: endUncaught } = Promise.withResolvers<Ending>()
const uncaughtSeen = { failed: false }
const onUncaught = (error: unknown): void => {
  console.error(error)
  uncaughtSeen.failed = true
  endUncaught({ code: 2, drainLimitMs: 1000 })
}
process.on('uncaughtException', onUncaught)
process.on('unhandledRejection', onUncaught)

// Typed as a command of any arguments, which is what the runner takes; defineCommand would type it by its own
const main: CommandDef = {
  meta: {
    name: 'bytebureau',
    version,
    description: 'ByteBureau — the AI office: a bureau of coding agents.',
  },
  // The global flags are the status's: they come before a sub-command as well, where citty needs to know which of them take a value
  args: { ...globalArgs },
  subCommands,
  // Citty runs this after a sub-command too; the status is what bytebureau tells when it is called with none
  async run({ args, rawArgs }) {
    if (args._.length === 0) {
      await runCommand(statusCommand, { rawArgs })
    }
  },
}

// A command with an exit code of its own (run: 3, 4; a request that is refused: 1) leaves it in process.exitCode
async function commandEnding(): Promise<Ending> {
  const code = await run(main, process.argv.slice(2))
  return { code: code === 0 ? (process.exitCode ?? 0) : code }
}

const ending = await Promise.race([commandEnding(), uncaught])
const { drainLimitMs } = ending
await Promise.all([drained(process.stdout, drainLimitMs), drained(process.stderr, drainLimitMs)])
// A failure nobody caught that came while the output drained still ends the process with exit code 2
process.exit(uncaughtSeen.failed ? 2 : ending.code)
