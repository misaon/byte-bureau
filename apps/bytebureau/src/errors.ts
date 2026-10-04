import {
  AskError,
  ConfigError,
  configErrorLine,
  PluginError,
  ProviderError,
  SessionError,
  StoreError,
  WorkspaceError,
} from '@bytebureau/kernel'

const KERNEL_ERRORS = [
  ConfigError,
  StoreError,
  WorkspaceError,
  ProviderError,
  AskError,
  PluginError,
  SessionError,
] as const

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

// A tagged error of the kernel says what went wrong through its name and fields; its message is only the reason
// An error with no message at all is told the same way
function isTyped(error: Error): boolean {
  return error.message === '' || KERNEL_ERRORS.some((type) => error instanceof type)
}

// A configuration error names its place first and once, as the line of a refusal does: its reason may name it already
function describeTyped(error: Error, describeCause: Describe): string {
  if (error instanceof ConfigError) {
    return `${error.name}: ${configErrorLine(error)}`
  }
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
  if (isTyped(error)) {
    return describeTyped(error, describeChain)
  }
  if (error.cause === undefined) {
    return error.message
  }
  const behind = describeChain(error.cause)
  const repeated = behind === error.message || behind.startsWith(`${error.message}: `)
  return repeated ? behind : `${error.message}: ${behind}`
}

// The one line to print for an error: the message, or what a tagged error of the kernel says in place of one
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }
  return isTyped(error) ? describeTyped(error, describeChain) : error.message
}
