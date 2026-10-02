#!/usr/bin/env bun
import { defineCommand, runMain } from 'citty'
import { helloCommand } from './commands/hello.js'
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

await runMain(main)
