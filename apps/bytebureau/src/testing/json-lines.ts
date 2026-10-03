export interface EventLine {
  readonly seq: number
  readonly type: string
  readonly payload: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Every line of the output is a JSON object, or the test says which line is not
export function jsonLines(stdout: string): readonly Record<string, unknown>[] {
  return stdout
    .trim()
    .split('\n')
    .map((line) => {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed)) {
        throw new TypeError(`not a JSON object: ${line}`)
      }
      return parsed
    })
}

// The same lines read as events: each has the seq and the type of an envelope
export function eventLines(stdout: string): readonly EventLine[] {
  return jsonLines(stdout).map((line) => {
    const { seq, type, payload } = line
    if (typeof seq !== 'number' || typeof type !== 'string') {
      throw new TypeError(`not an event: ${JSON.stringify(line)}`)
    }
    return { seq, type, payload }
  })
}

// The payload of the first event of the type, if the output has one
export function payloadOf(events: readonly EventLine[], type: string): unknown {
  const found = events.find((line) => line.type === type)
  return found === undefined ? undefined : found.payload
}
