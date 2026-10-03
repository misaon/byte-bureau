import { runCommand, showUsage, type CommandDef, type Resolvable } from 'citty'
import { describeError } from './errors.js'

const HELP_FLAGS: ReadonlySet<string> = new Set(['--help', '-h'])
const VERSION_FLAGS: ReadonlySet<string> = new Set(['--version', '-v'])

async function resolved<Value extends object>(value: Resolvable<Value>): Promise<Value> {
  const settled = await (typeof value === 'function' ? value() : value)
  return settled
}

// Usage mistakes throw citty's CLIError, a class citty does not export
function isUsageError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'CLIError'
}

// Usage of the deepest subcommand named in argv, as citty's runMain prints it
async function printUsage(
  command: CommandDef,
  argv: readonly string[],
  parent?: CommandDef,
): Promise<void> {
  const subCommands = command.subCommands === undefined ? {} : await resolved(command.subCommands)
  const index = argv.findIndex((arg) => !arg.startsWith('-'))
  const subCommand = index === -1 ? undefined : subCommands[argv[index] ?? '']
  if (subCommand === undefined) {
    await showUsage(command, parent)
    return
  }
  await printUsage(await resolved(subCommand), argv.slice(index + 1), command)
}

async function printVersion(command: CommandDef): Promise<void> {
  const meta = command.meta === undefined ? {} : await resolved(command.meta)
  if (meta.version === undefined) {
    throw Object.assign(new Error('No version specified'), { name: 'CLIError' })
  }
  console.log(meta.version)
}

// A bare --debug debugs every category; as --debug= it takes nothing from the argument after it
// What follows -- is no flag
function withBareDebug(argv: readonly string[]): string[] {
  const end = argv.indexOf('--')
  return argv.map((arg, index) =>
    arg === '--debug' && (end === -1 || index < end) ? '--debug=' : arg,
  )
}

async function execute(command: CommandDef, argv: readonly string[]): Promise<void> {
  if (argv.some((arg) => HELP_FLAGS.has(arg))) {
    await printUsage(command, argv)
  } else if (argv.length === 1 && VERSION_FLAGS.has(argv[0] ?? '')) {
    await printVersion(command)
  } else {
    await runCommand(command, { rawArgs: withBareDebug(argv) })
  }
}

// Exit codes: 0 success, 1 usage error (citty's CLIError), 2 anything else
export async function run(command: CommandDef, argv: readonly string[]): Promise<number> {
  try {
    await execute(command, argv)
    return 0
  } catch (error) {
    if (isUsageError(error)) {
      await printUsage(command, argv)
      console.error(error.message)
      return 1
    }
    console.error(describeError(error))
    return 2
  }
}
