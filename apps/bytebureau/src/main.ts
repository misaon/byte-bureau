#!/usr/bin/env bun
import { defineCommand } from 'citty'
import { helloCommand } from './commands/hello.js'
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
  subCommands: { hello: helloCommand },
})

process.exit(await run(main, process.argv.slice(2)))
