import { lstatSync, readFileSync, statSync, type Stats } from 'node:fs'
import path from 'node:path'
import { Effect } from 'effect'
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'
import { ConfigError } from '../errors.js'
import { pointerOf } from './issues.js'
import { isPlain, type Plain } from './merge.js'

// Configuration files are data: the kernel reads JSON or JSONC as text and parses it with jsonc-parser, nothing is imported or run
const EXTENSIONS = ['.json', '.jsonc'] as const

const BOM = '\uFEFF'

export interface LoadedFile {
  readonly file: string
  readonly config: Plain
}

type Entry = 'absent' | 'dangling' | 'file' | 'other'

interface Candidate {
  readonly file: string
  readonly entry: Entry
}

const failure = (file: string, reason: string): ConfigError =>
  new ConfigError({ file, pointer: '', reason })

// A link to nowhere shows up in lstat but not in stat; a link to a file is followed and read as text
function entryOf(candidate: string): Entry {
  if (lstatSync(candidate, { throwIfNoEntry: false }) === undefined) {
    return 'absent'
  }
  const stats = statSync(candidate, { throwIfNoEntry: false })
  if (stats === undefined) {
    return 'dangling'
  }
  return stats.isFile() ? 'file' : 'other'
}

const candidatesOf = (directory: string, name: string): readonly Candidate[] =>
  EXTENSIONS.map((extension) => {
    const file = path.resolve(directory, `${name}${extension}`)
    return { file, entry: entryOf(file) }
  })

// At most one regular file; a link to nowhere or both variants is an error
function chooseFile(candidates: readonly Candidate[]): Effect.Effect<string | null, ConfigError> {
  const dangling = candidates.find((candidate) => candidate.entry === 'dangling')
  if (dangling !== undefined) {
    return Effect.fail(failure(dangling.file, 'a symbolic link whose target does not exist'))
  }
  const [first, second] = candidates.filter((candidate) => candidate.entry === 'file')
  if (first !== undefined && second !== undefined) {
    const reason = `${first.file} and ${second.file} both exist; keep one of them`
    return Effect.fail(failure(first.file, reason))
  }
  return Effect.succeed(first === undefined ? null : first.file)
}

// 1-based line and column of an offset
function positionOf(text: string, offset: number): string {
  const before = text.slice(0, offset)
  return `line ${before.split('\n').length}, column ${offset - before.lastIndexOf('\n')}`
}

interface Parsed {
  readonly value: unknown
  readonly errors: readonly ParseError[]
  // The keys to the first object whose prototype a "__proto__" key replaced, if any
  readonly prototyped: readonly string[] | null
}

const childrenOf = (value: object): readonly (readonly [string, unknown])[] =>
  Array.isArray(value)
    ? value.map((item: unknown, index) => [String(index), item] as const)
    : Object.entries(value)

// The parser assigns the keys it reads, so a "__proto__" key sets the prototype of its object instead of becoming a key
function prototypedPath(value: unknown, keys: readonly string[]): readonly string[] | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const prototype = Reflect.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return [...keys, '__proto__']
  }
  for (const [key, child] of childrenOf(value)) {
    const found = prototypedPath(child, [...keys, key])
    if (found !== null) {
      return found
    }
  }
  return null
}

function parseText(text: string): Parsed {
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true, allowEmptyContent: true })
  return { value, errors, prototyped: prototypedPath(value, []) }
}

// The parser recurses, so a pathologically nested file throws instead of returning
function parseConfig(file: string, raw: string): Effect.Effect<Plain, ConfigError> {
  const text = raw.startsWith(BOM) ? raw.slice(BOM.length) : raw
  return Effect.gen(function* parseJson() {
    const { value, errors, prototyped } = yield* Effect.try({
      try: () => parseText(text),
      catch: (cause) => failure(file, String(cause)),
    })
    const [first] = errors
    if (first !== undefined) {
      const position = positionOf(text, first.offset)
      return yield* failure(file, `${printParseErrorCode(first.error)} at ${position}`)
    }
    if (prototyped !== null) {
      const reason = 'a "__proto__" key is not allowed'
      return yield* new ConfigError({ file, pointer: pointerOf(prototyped), reason })
    }
    return isPlain(value) ? value : yield* failure(file, 'expected a JSON object')
  })
}

const loadFile = (file: string): Effect.Effect<LoadedFile, ConfigError> =>
  Effect.gen(function* loadJson() {
    const text = yield* Effect.try({
      try: () => readFileSync(file, 'utf8'),
      catch: (cause) => failure(file, String(cause)),
    })
    const config = yield* parseConfig(file, text)
    return { file, config }
  })

// `<name>.json` or `<name>.jsonc` in the directory, read as text and parsed with jsonc-parser; null when neither exists
export const readLayer = (
  directory: string,
  name: string,
): Effect.Effect<LoadedFile | null, ConfigError> =>
  Effect.gen(function* readJsonLayer() {
    const candidates = yield* Effect.try({
      try: () => candidatesOf(directory, name),
      catch: (cause) => failure(directory, String(cause)),
    })
    const file = yield* chooseFile(candidates)
    return file === null ? null : yield* loadFile(file)
  })

const directoryProblem = (stats: Stats | undefined): string | null => {
  if (stats === undefined) {
    return 'the project path does not exist'
  }
  return stats.isDirectory() ? null : 'the project path is not a directory'
}

export const requireDirectory = (directory: string): Effect.Effect<void, ConfigError> =>
  Effect.try({
    try: () => statSync(directory, { throwIfNoEntry: false }),
    catch: (cause) => failure(directory, String(cause)),
  }).pipe(
    Effect.flatMap((stats) => {
      const problem = directoryProblem(stats)
      return problem === null ? Effect.void : Effect.fail(failure(directory, problem))
    }),
  )
