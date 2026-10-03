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

// The one line to print for an error: the message, or what a tagged error of the kernel says in place of one
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }
  return error.message === '' ? describeTyped(error, describeChain) : error.message
}
