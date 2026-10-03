#!/usr/bin/env bun
import { defineCommand } from 'citty'
import { configCommand } from './commands/config.js'
import { helloCommand } from './commands/hello.js'
import { projectsCommand } from './commands/projects.js'
import { runCommand } from './commands/run.js'
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
  },
})

// A command with an exit code of its own (run: 3, 4; config: 1) leaves it in process.exitCode
const code = await run(main, process.argv.slice(2))
process.exit(code === 0 ? (process.exitCode ?? 0) : code)
