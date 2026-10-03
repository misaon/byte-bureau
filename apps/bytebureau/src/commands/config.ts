import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { m } from '@bytebureau/i18n'
import { defaultProjectConfigText } from '@bytebureau/kernel'
import { defineCommand } from 'citty'
import { globalArgs, processContext } from '../context.js'
import { withKernel } from '../kernel.js'

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

function writeConfig(directory: string): string {
  const file = path.join(directory, 'bytebureau.jsonc')
  writeFileSync(file, defaultProjectConfigText())
  return file
}

const init = defineCommand({
  meta: {
    name: 'init',
    description: 'Write a commented bytebureau.jsonc with the default employee',
  },
  args: { ...globalArgs, project: PROJECT_ARG },
  run({ args }) {
    const context = processContext(args)
    const directory = path.resolve(args.project ?? process.cwd())
    const existing = existingConfig(directory)
    if (existing !== undefined) {
      context.output.warn(m.config_init_exists({ file: existing }))
      process.exitCode = 1
      return
    }
    const file = writeConfig(directory)
    context.output.print(m.config_init_written({ file }))
    context.output.emit({ command: 'config.init', file })
  },
})

const validate = defineCommand({
  meta: { name: 'validate', description: 'Validate the layered configuration for a project' },
  args: { ...globalArgs, project: PROJECT_ARG },
  async run({ args }) {
    const context = processContext(args)
    const issues = await withKernel(context, process.env, async (kernel) => {
      const found = await kernel.config.validate(args.project ?? process.cwd())
      return found
    })
    context.output.emit({ command: 'config.validate', issues })
    if (issues.length === 0) {
      context.output.print(m.config_valid())
      return
    }
    for (const issue of issues) {
      context.output.print(`${issue.file}${issue.pointer}: ${issue.message}`)
    }
    context.output.warn(m.config_invalid({ count: issues.length }))
    process.exitCode = 1
  },
})

const schema = defineCommand({
  meta: { name: 'schema', description: 'Print the JSON Schema of bytebureau.json' },
  args: { ...globalArgs },
  async run({ args }) {
    const context = processContext(args)
    const document = await withKernel(context, process.env, async (kernel) => {
      await Promise.resolve()
      return kernel.config.schema()
    })
    console.log(JSON.stringify(document, undefined, 2))
  },
})

export const configCommand = defineCommand({
  meta: { name: 'config', description: 'Create, validate and describe the configuration' },
  subCommands: { init, validate, schema },
})
