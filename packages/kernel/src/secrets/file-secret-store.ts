import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'
import type { SecretsShape } from './secrets.js'

type Values = Readonly<Record<string, string>>

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'

const isValues = (value: unknown): value is Values =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === 'string')

// The text of the file; nothing while there is no file
const textOf = (file: string): string | undefined => {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (isMissing(error)) {
      return undefined
    }
    throw error
  }
}

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
  const text = textOf(file)
  if (text === undefined) {
    return {}
  }
  const values = parsed(text)
  if (!isValues(values)) {
    throw new Error(`${path.basename(file)} does not hold a secret store`)
  }
  return values
}

// Written beside the file for the user alone, flushed and moved into place, so a reader never sees half a store
// The mode is set again in case an earlier write left the draft behind with another one
const writePrivate = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const draft = `${file}.tmp`
  const fd = openSync(draft, 'w', 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  chmodSync(draft, 0o600)
  renameSync(draft, file)
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
