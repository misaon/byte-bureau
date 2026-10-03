import { readFileSync, statSync, type Stats } from 'node:fs'
import path from 'node:path'
import { loadConfig } from 'c12'
import { Effect } from 'effect'
import { ConfigError } from '../errors.js'
import type { Plain } from './merge.js'

// Only the parser of c12 is used: no rc files, dotenv, package.json, environment keys, presets or downloads
const BASE = {
  name: 'bytebureau',
  rcFile: false,
  globalRc: false,
  dotenv: false,
  packageJson: false,
  envName: false,
  extend: false,
  giget: false,
} as const

// Configuration files are data: JSON or JSONC, never a script that c12 would run
const EXTENSIONS = ['.json', '.jsonc'] as const

export interface LoadedFile {
  readonly file: string
  readonly config: Plain
}

const failure = (file: string, reason: string): ConfigError =>
  new ConfigError({ file, pointer: '', reason })

// Regular files only; the exact name keeps c12 from matching a release binary or the process directory
function existingFiles(directory: string, name: string): readonly string[] {
  return EXTENSIONS.map((extension) => path.resolve(directory, `${name}${extension}`)).filter(
    (candidate) => {
      const stats = statSync(candidate, { throwIfNoEntry: false })
      return stats !== undefined && stats.isFile()
    },
  )
}

const COMMENTS = /\/\/[^\n]*|\/\*[\s\S]*?\*\//gu

// An array passes through c12 and null crashes it, so the root is checked before the parse
function hasObjectRoot(text: string): boolean {
  const body = text.replaceAll(COMMENTS, ' ').trim()
  return body !== 'null' && !body.startsWith('[')
}

const loadFile = (file: string): Effect.Effect<LoadedFile, ConfigError> =>
  Effect.gen(function* loadJson() {
    const text = yield* Effect.try({
      try: () => readFileSync(file, 'utf8'),
      catch: (cause) => failure(file, String(cause)),
    })
    if (!hasObjectRoot(text)) {
      return yield* failure(file, 'expected a JSON object')
    }
    const config = yield* Effect.tryPromise({
      try: async () => {
        const loaded = await loadConfig<Plain>({
          ...BASE,
          cwd: path.dirname(file),
          configFile: path.basename(file),
        })
        return loaded.config
      },
      catch: (cause) => failure(file, String(cause)),
    })
    return { file, config }
  })

// `<name>.json` or `<name>.jsonc` in the directory; null when neither exists, an error when both do
export const readLayer = (
  directory: string,
  name: string,
): Effect.Effect<LoadedFile | null, ConfigError> =>
  Effect.gen(function* readJsonLayer() {
    const found = yield* Effect.try({
      try: () => existingFiles(directory, name),
      catch: (cause) => failure(directory, String(cause)),
    })
    const [first, second] = found
    if (first === undefined) {
      return null
    }
    if (second !== undefined) {
      return yield* failure(first, `${first} and ${second} both exist; keep one of them`)
    }
    return yield* loadFile(first)
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
