import { ProjectConfig, UserConfig } from '@bytebureau/protocol'
import { Effect, Schema } from 'effect'
import type { StandardSchemaV1 } from 'effect/StandardSchema'
import { ConfigError } from '../errors.js'
import type { ConfigLayer, Plain } from './merge.js'

export interface ConfigIssue {
  readonly file: string
  readonly pointer: string
  readonly message: string
}

interface Checked<Value> {
  readonly value: Value | undefined
  readonly issues: readonly ConfigIssue[]
}

const STRICT = { onExcessProperty: 'error', errors: 'all' } as const

// The copies keep protocol's schemas clean: toStandardSchemaV1 attaches ~standard to the schema it receives
const projectStandard = Schema.toStandardSchemaV1(ProjectConfig.annotate({}), {
  parseOptions: STRICT,
})
const userStandard = Schema.toStandardSchemaV1(UserConfig.annotate({}), { parseOptions: STRICT })

const escapeSegment = (segment: string): string =>
  segment.replaceAll('~', '~0').replaceAll('/', '~1')

// RFC 6901: the document itself is the empty pointer
export const pointerOf = (keys: readonly PropertyKey[]): string =>
  keys.map((key) => `/${escapeSegment(String(key))}`).join('')

function containsPath(root: unknown, keys: readonly PropertyKey[]): boolean {
  let cursor = root
  for (const key of keys) {
    if (typeof cursor !== 'object' || cursor === null || !Object.hasOwn(cursor, key)) {
      return false
    }
    cursor = Reflect.get(cursor, key)
  }
  return cursor !== undefined
}

// The highest layer that holds the value; a missing key has none, so the files that hold its parent decide
function labelOf(
  layers: readonly ConfigLayer[],
  keys: readonly PropertyKey[],
  fallback: string,
): string {
  const owner = layers.findLast((layer) => containsPath(layer.config, keys))
  if (owner !== undefined) {
    return owner.label
  }
  const parent = keys.slice(0, -1)
  const holder = layers.findLast((layer) => layer.fromFile && containsPath(layer.config, parent))
  return holder === undefined ? fallback : holder.label
}

const validated = <Value>(
  standard: StandardSchemaV1<unknown, Value>,
  input: Plain,
  attribute: (keys: readonly PropertyKey[]) => string,
): Effect.Effect<Checked<Value>> =>
  Effect.promise(async () => {
    const result = await standard['~standard'].validate(input)
    if (result.issues === undefined) {
      return { value: result.value, issues: [] }
    }
    const issues = result.issues.map((issue) => {
      const keys = (issue.path ?? []).map((segment) =>
        typeof segment === 'object' ? segment.key : segment,
      )
      return { file: attribute(keys), pointer: pointerOf(keys), message: issue.message }
    })
    return { value: undefined, issues }
  })

// Layers run lowest first; a missing key without a file holding its parent goes to the fallback
export const checkProject = (
  merged: Plain,
  layers: readonly ConfigLayer[],
  fallback: string,
): Effect.Effect<Checked<ProjectConfig>> =>
  validated(projectStandard, merged, (keys) => labelOf(layers, keys, fallback))

export const checkUser = (user: Plain, file: string): Effect.Effect<Checked<UserConfig>> =>
  validated(userStandard, user, () => file)

// The logging section of the user file is checked twice, as the user file and as part of the project
export function distinct(issues: readonly ConfigIssue[]): readonly ConfigIssue[] {
  const unique = new Map(
    issues.map(
      (issue) => [JSON.stringify([issue.file, issue.pointer, issue.message]), issue] as const,
    ),
  )
  return [...unique.values()]
}

// The first issue names the file and the pointer; the reason lists every issue
export function configErrorOf(issues: readonly ConfigIssue[]): ConfigError {
  const [first] = issues
  const { file, pointer } = first ?? { file: '', pointer: '' }
  const reason = issues.map((issue) => `${issue.file}${issue.pointer}: ${issue.message}`).join('; ')
  return new ConfigError({ file, pointer, reason })
}
