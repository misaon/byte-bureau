import { runCommand, showUsage, type CommandDef, type Resolvable } from 'citty'

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

async function execute(command: CommandDef, argv: readonly string[]): Promise<void> {
  if (argv.some((arg) => HELP_FLAGS.has(arg))) {
    await printUsage(command, argv)
  } else if (argv.length === 1 && VERSION_FLAGS.has(argv[0] ?? '')) {
    await printVersion(command)
  } else {
    await runCommand(command, { rawArgs: [...argv] })
  }
}

function field(error: Error, key: string): string | undefined {
  const value: unknown = Reflect.get(error, key)
  return typeof value === 'string' ? value : undefined
}

type Describe = (error: unknown) => string

// The reason a typed error names, else the story of its cause (a StoreError carries nothing but that)
function reasonOf(error: Error, describeCause: Describe): string | undefined {
  const reason = field(error, 'reason')
  return reason === undefined && error.cause !== undefined ? describeCause(error.cause) : reason
}

// A file with its JSON pointer, else the code or the kind of the failure
function whereOf(error: Error): string | undefined {
  const file = field(error, 'file')
  if (file !== undefined) {
    return `${file}${field(error, 'pointer') ?? ''}`
  }
  return field(error, 'code') ?? field(error, 'kind')
}

// The tagged errors of the kernel have an empty message: their name and fields say what went wrong
function describeTyped(error: Error, describeCause: Describe): string {
  const reason = reasonOf(error, describeCause)
  const head = reason === undefined ? error.name : `${error.name}: ${reason}`
  const where = whereOf(error)
  return where === undefined ? head : `${head} (${where})`
}

// An error and the errors behind it: "Failed to execute statement: FOREIGN KEY constraint failed"
// An error behind that already begins with what this one says is not told twice
function describeChain(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }
  if (error.message === '') {
    return describeTyped(error, describeChain)
  }
  if (error.cause === undefined) {
    return error.message
  }
  const behind = describeChain(error.cause)
  const repeated = behind === error.message || behind.startsWith(`${error.message}: `)
  return repeated ? behind : `${error.message}: ${behind}`
}

// The one line the runner prints for an error
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }
  return error.message === '' ? describeTyped(error, describeChain) : error.message
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
