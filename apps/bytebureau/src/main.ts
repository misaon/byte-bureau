#!/usr/bin/env bun
import { defineCommand } from 'citty'
import { configCommand } from './commands/config.js'
import { helloCommand } from './commands/hello.js'
import { projectsCommand } from './commands/projects.js'
import { runCommand } from './commands/run.js'
import { serveCommand } from './commands/serve.js'
import { workspacesCommand } from './commands/workspaces.js'
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

const main = defineCommand({
  meta: {
    name: 'bytebureau',
    version,
    description: 'ByteBureau — the AI office: a bureau of coding agents.',
  },
  subCommands: {
    hello: helloCommand,
    run: runCommand,
    config: configCommand,
    projects: projectsCommand,
    workspaces: workspacesCommand,
    serve: serveCommand,
  },
})

// A command with an exit code of its own (run: 3, 4; config: 1) leaves it in process.exitCode
async function commandEnding(): Promise<Ending> {
  const code = await run(main, process.argv.slice(2))
  return { code: code === 0 ? (process.exitCode ?? 0) : code }
}

const ending = await Promise.race([commandEnding(), uncaught])
const { drainLimitMs } = ending
await Promise.all([drained(process.stdout, drainLimitMs), drained(process.stderr, drainLimitMs)])
// A failure nobody caught that came while the output drained still ends the process with exit code 2
process.exit(uncaughtSeen.failed ? 2 : ending.code)
