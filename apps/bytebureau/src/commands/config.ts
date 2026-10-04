import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { m } from '@bytebureau/i18n'
import {
  configReader,
  defaultProjectConfigText,
  type ConfigIssue,
  type ConfigReader,
} from '@bytebureau/kernel'
import { defineCommand } from 'citty'
import {
  commonArgs,
  processContext,
  refuseBureauFlags,
  type Context,
  type GlobalArgs,
} from '../context.js'
import { kernelHome } from '../kernel-home.js'

const PROJECT_ARG = {
  type: 'string',
  description: 'Project path (default: current directory)',
} as const

// The kernel refuses a directory that has both
const CONFIG_FILES = ['bytebureau.json', 'bytebureau.jsonc'] as const

// The config file a directory already has, if any
function existingConfig(directory: string): string | undefined {
  return CONFIG_FILES.map((name) => path.join(directory, name)).find((file) => existsSync(file))
}

// Creates the file unless anything is there (a link to nowhere too): the file is never written through a link
function createConfig(file: string): boolean {
  try {
    writeFileSync(file, defaultProjectConfigText(), { flag: 'wx' })
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      return false
    }
    throw error
  }
}

// The configuration is files this process reads: config never talks to a daemon, and opens no store beside one
const readerOf = (context: Context): ConfigReader =>
  configReader(kernelHome(context.env), context.env)

// The context of a config command, which talks to no daemon and so takes no flag that chooses one
const contextOf = (
  command: string,
  { args, rawArgs }: { readonly args: GlobalArgs; readonly rawArgs: readonly string[] },
): Context => {
  refuseBureauFlags(`config ${command}`, rawArgs)
  return processContext(args)
}

// The issues one to a line and their count, exit code 1; or that the configuration is valid
function tell(context: Context, issues: readonly ConfigIssue[]): void {
  if (issues.length === 0) {
    context.output.print(m.config_valid())
    return
  }
  for (const issue of issues) {
    context.output.print(`${issue.file}${issue.pointer}: ${issue.message}`)
  }
  context.output.warn(m.config_invalid({ count: issues.length }))
  process.exitCode = 1
}

const init = defineCommand({
  meta: {
    name: 'init',
    description: 'Write a commented bytebureau.jsonc with the default employee',
  },
  args: { ...commonArgs, project: PROJECT_ARG },
  run({ args, rawArgs }) {
    const context = contextOf('init', { args, rawArgs })
    const directory = path.resolve(args.project ?? process.cwd())
    const file = path.join(directory, 'bytebureau.jsonc')
    const existing = existingConfig(directory)
    if (existing === undefined && createConfig(file)) {
      context.output.print(m.config_init_written({ file }))
      context.output.emit({ command: 'config.init', file })
      return
    }
    context.output.warn(m.config_init_exists({ file: existing ?? file }))
    process.exitCode = 1
  },
})

const validate = defineCommand({
  meta: { name: 'validate', description: 'Validate the layered configuration for a project' },
  args: { ...commonArgs, project: PROJECT_ARG },
  async run({ args, rawArgs }) {
    const context = contextOf('validate', { args, rawArgs })
    const issues = await readerOf(context).validate(args.project ?? process.cwd())
    context.output.emit({ command: 'config.validate', issues })
    tell(context, issues)
  },
})

const schema = defineCommand({
  meta: { name: 'schema', description: 'Print the JSON Schema of bytebureau.json' },
  args: { ...commonArgs },
  run({ args, rawArgs }) {
    const context = contextOf('schema', { args, rawArgs })
    console.log(JSON.stringify(readerOf(context).schema(), undefined, 2))
  },
})

export const configCommand = defineCommand({
  meta: { name: 'config', description: 'Create, validate and describe the configuration' },
  subCommands: { init, validate, schema },
})
