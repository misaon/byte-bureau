import { ApiError } from '@bytebureau/client'
import { m } from '@bytebureau/i18n'
import {
  runCommand,
  showUsage,
  type ArgsDef,
  type CommandDef,
  type Resolvable,
  type SubCommandsDef,
} from 'citty'
import { DaemonRunningError } from './bureau/open-local.js'
import { describeError } from './errors.js'
import { usageError } from './usage-error.js'

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

// Where a walk down the commands that argv names has come to
interface Walked {
  readonly command: CommandDef
  readonly parent: CommandDef | undefined
  // The commands it went through, as named
  readonly names: readonly string[]
  // The flags before those names, with their values
  readonly flags: readonly string[]
  // What follows the last name
  readonly rest: readonly string[]
  // A name the command it was given to has no sub-command of
  readonly unknown?: string | undefined
}

interface Level {
  readonly subCommands: SubCommandsDef
  // The flags of this command and of those above it
  readonly known: ArgsDef
}

async function levelOf(command: CommandDef, above: ArgsDef): Promise<Level> {
  const subCommands = command.subCommands === undefined ? {} : await resolved(command.subCommands)
  const own = command.args === undefined ? {} : await resolved(command.args)
  return { subCommands, known: { ...above, ...own } }
}

// Citty tells the sub-command of a command by the flags of that command alone, so a group would take the value of a global flag for a name
// The walk knows the flags of every level above, and stops at the command that has no sub-commands, or at a name that is none
async function descend(walked: Walked, above: ArgsDef): Promise<Walked> {
  const { subCommands, known } = await levelOf(walked.command, above)
  const index = Object.keys(subCommands).length === 0 ? -1 : subCommandIndex(walked.rest, known)
  const name = index === -1 ? undefined : walked.rest[index]
  if (name === undefined) {
    return walked
  }
  const named = {
    ...walked,
    names: [...walked.names, name],
    flags: [...walked.flags, ...walked.rest.slice(0, index)],
    rest: walked.rest.slice(index + 1),
  }
  // Own names only: citty's lookup would find the prototype's constructor of a name such as constructor
  const subCommand = Object.hasOwn(subCommands, name) ? subCommands[name] : undefined
  if (subCommand === undefined) {
    return { ...named, unknown: name }
  }
  return descend({ ...named, command: await resolved(subCommand), parent: walked.command }, known)
}

async function walk(command: CommandDef, argv: readonly string[]): Promise<Walked> {
  const walked = await descend({ command, parent: undefined, names: [], flags: [], rest: argv }, {})
  return walked
}

// Citty hands a command only the arguments after its name, and it parses its flags there
// The flags before a name, at any level, move to right behind the last name, ahead of the arguments of the command itself, so those win; a -- keeps what follows it
export async function flagsAtLeaf(command: CommandDef, argv: readonly string[]): Promise<string[]> {
  const { names, flags, rest } = await walk(command, argv)
  return [...names, ...flags, ...rest]
}

// Usage of the deepest command named in argv, as citty's runMain prints it
async function printUsage(command: CommandDef, argv: readonly string[]): Promise<void> {
  const { command: deepest, parent } = await walk(command, argv)
  await showUsage(deepest, parent)
}

async function printVersion(command: CommandDef): Promise<void> {
  const meta = command.meta === undefined ? {} : await resolved(command.meta)
  if (meta.version === undefined) {
    throw usageError('No version specified')
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

// What the walk ended at that citty would read otherwise: a name that is no sub-command, a group named without its leaf
// (so that the value of a flag before it is never taken for a leaf), or a name after -- where no command is named
async function refusalOf({ command, names, rest, unknown }: Walked): Promise<string | undefined> {
  if (unknown !== undefined) {
    return `Unknown command \`${unknown}\``
  }
  const subCommands = command.subCommands === undefined ? {} : await resolved(command.subCommands)
  if (Object.keys(subCommands).length > 0 && command.run === undefined) {
    return 'No command specified.'
  }
  const end = rest.indexOf('--')
  return names.length === 0 && end !== -1 && end < rest.length - 1
    ? 'No command specified: a command name goes before --'
    : undefined
}

async function runWalked(command: CommandDef, argv: readonly string[]): Promise<void> {
  const walked = await walk(command, argv)
  const refusal = await refusalOf(walked)
  if (refusal !== undefined) {
    throw usageError(refusal)
  }
  await runCommand(command, { rawArgs: [...walked.names, ...walked.flags, ...walked.rest] })
}

async function execute(command: CommandDef, argv: readonly string[]): Promise<void> {
  if (argv.some((arg) => HELP_FLAGS.has(arg))) {
    await printUsage(command, argv)
  } else if (argv.length === 1 && VERSION_FLAGS.has(argv[0] ?? '')) {
    await printVersion(command)
  } else {
    await runWalked(command, argv)
  }
}

// Whether the arguments name the daemon to talk to with --host or --port; what follows -- is no flag
const namesDaemon = (argv: readonly string[]): boolean => {
  const end = argv.indexOf('--')
  return (end === -1 ? argv : argv.slice(0, end)).some((arg) =>
    /^--(?:host|port)(?:=|$)/u.test(arg),
  )
}

// The line of a failure; a daemon named on the command line that refuses the token is told where its token goes, as in a refusal
const failureLine = (error: unknown, argv: readonly string[]): string =>
  error instanceof ApiError &&
  error.status === 401 &&
  error.problem !== undefined &&
  namesDaemon(argv)
    ? m.bureau_token_hint({ detail: error.problem.detail })
    : describeError(error)

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
  console.error(failureLine(error, argv))
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
