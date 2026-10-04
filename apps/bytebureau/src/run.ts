import { runCommand, showUsage, type ArgsDef, type CommandDef, type Resolvable } from 'citty'
import { DaemonRunningError } from './bureau/open-local.js'
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

// The camelCase of a flag or of the name of an argument, as citty compares them: log-level and logLevel are one
function camel(name: string): string {
  return name.replaceAll(/-+(?<letter>[a-z])/gu, (_match, letter: string) => letter.toUpperCase())
}

// Whether the argument after a flag is its value, as citty tells: the flag is a string one, and is not spelled with =
function takesValue(flag: string, args: ArgsDef): boolean {
  if (flag.includes('=')) {
    return false
  }
  const name = flag.replace(/^-{1,2}/u, '')
  return Object.entries(args).some(([key, definition]) => {
    if (definition.type !== 'string' && definition.type !== 'enum') {
      return false
    }
    const aliases = typeof definition.alias === 'string' ? [definition.alias] : definition.alias
    return camel(key) === camel(name) || (aliases ?? []).includes(name)
  })
}

// Where the sub-command is in the arguments, as citty finds it: the first argument that is no flag and no value of a flag that takes one
export function subCommandIndex(argv: readonly string[], args: ArgsDef, from = 0): number {
  const arg = argv[from]
  if (arg === undefined || arg === '--') {
    return -1
  }
  if (!arg.startsWith('-')) {
    return from
  }
  return subCommandIndex(argv, args, from + (takesValue(arg, args) ? 2 : 1))
}

// Citty hands a sub-command only the arguments after its name, and it parses its flags
// The flags before it move behind it, to the end of the arguments, which a nested command parses too; a -- keeps what follows it
async function flagsAfterSubCommand(
  command: CommandDef,
  argv: readonly string[],
): Promise<string[]> {
  const args = command.args === undefined ? {} : await resolved(command.args)
  const index = subCommandIndex(argv, args)
  if (index <= 0) {
    return [...argv]
  }
  const rest = argv.slice(index)
  const end = rest.includes('--') ? rest.indexOf('--') : rest.length
  return [...rest.slice(0, end), ...argv.slice(0, index), ...rest.slice(end)]
}

// Usage of the deepest subcommand named in argv, as citty's runMain prints it
async function printUsage(
  command: CommandDef,
  argv: readonly string[],
  parent?: CommandDef,
): Promise<void> {
  const subCommands = command.subCommands === undefined ? {} : await resolved(command.subCommands)
  const args = command.args === undefined ? {} : await resolved(command.args)
  const index = subCommandIndex(argv, args)
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
    const rawArgs = await flagsAfterSubCommand(command, argv)
    await runCommand(command, { rawArgs })
  }
}

// The exit code of a failure, which is told on stderr: 1 for a usage error and for --no-daemon beside a live daemon, 2 for anything else
async function failed(
  command: CommandDef,
  argv: readonly string[],
  error: unknown,
): Promise<number> {
  if (isUsageError(error)) {
    await printUsage(command, argv)
    console.error(error.message)
    return 1
  }
  if (error instanceof DaemonRunningError) {
    console.error(error.message)
    return 1
  }
  console.error(describeError(error))
  return 2
}

// Exit codes: 0 success, 1 usage error (citty's CLIError) or a refused --no-daemon, 2 anything else
// A bare --debug is told from a flag with a value before the arguments are read for the usage as for the run
export async function run(command: CommandDef, argv: readonly string[]): Promise<number> {
  const args = withBareDebug(argv)
  try {
    await execute(command, args)
    return 0
  } catch (error) {
    const code = await failed(command, args, error)
    return code
  }
}
