#!/usr/bin/env bun
import { defineCommand } from 'citty'
import { configCommand } from './commands/config.js'
import { helloCommand } from './commands/hello.js'
import { projectsCommand } from './commands/projects.js'
import { runCommand } from './commands/run.js'
import { serveCommand } from './commands/serve.js'
import { workspacesCommand } from './commands/workspaces.js'
import { run } from './run.js'
import { version } from './version.js'

process.on('uncaughtException', (error: unknown) => {
  console.error(error)
  process.exit(2)
})
process.on('unhandledRejection', (error: unknown) => {
  console.error(error)
  process.exit(2)
})

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

// Bun writes to a pipe asynchronously: an exit that does not wait for the writes would lose the last lines of NDJSON
async function drained(stream: NodeJS.WriteStream): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  stream.write('', () => {
    resolve(true)
  })
  await promise
}

// A command with an exit code of its own (run: 3, 4; config: 1) leaves it in process.exitCode
const code = await run(main, process.argv.slice(2))
await Promise.all([drained(process.stdout), drained(process.stderr)])
process.exit(code === 0 ? (process.exitCode ?? 0) : code)
