import path from 'node:path'
import { readIfPresent, writePrivate } from './private-file.js'
import type { SecretsShape } from './secrets.js'

type Values = Readonly<Record<string, string>>

const isValues = (value: unknown): value is Values =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === 'string')

// What the text holds; nothing for text that is no JSON
const parsed = (text: string): unknown => {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    return undefined
  }
}

// The file as a map of keys to values, empty while there is no file; anything else in it is refused, never overwritten
const read = (file: string): Values => {
  const text = readIfPresent(file)
  if (text === undefined) {
    return {}
  }
  const values = parsed(text)
  if (!isValues(values)) {
    throw new Error(`${path.basename(file)} does not hold a secret store`)
  }
  return values
}

const write = (file: string, values: Values): void => {
  writePrivate(file, `${JSON.stringify(values, null, 2)}\n`)
}

// Secrets in one JSON file under the home, for the user alone: the fallback where no keychain serves the daemon
export class FileSecretStore implements SecretsShape {
  public readonly backend = 'file' as const
  private readonly file: string

  public constructor(file: string) {
    this.file = file
  }

  public async get(key: string): Promise<string | undefined> {
    await Promise.resolve()
    const values = read(this.file)
    return Object.hasOwn(values, key) ? values[key] : undefined
  }

  public async set(key: string, value: string): Promise<void> {
    await Promise.resolve()
    write(this.file, { ...read(this.file), [key]: value })
  }

  // A key the file does not hold leaves it as it is, or absent
  public async delete(key: string): Promise<void> {
    await Promise.resolve()
    const values = read(this.file)
    if (Object.hasOwn(values, key)) {
      write(this.file, Object.fromEntries(Object.entries(values).filter(([name]) => name !== key)))
    }
  }
}
