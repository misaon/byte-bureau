import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  ProjectConfig,
  configJsonSchema,
  decodeUserConfig,
  defaultProjectConfig,
  type UserConfig,
} from '@bytebureau/protocol'
import { loadConfig, SUPPORTED_EXTENSIONS } from 'c12'
import { Context, Effect, Layer, Schema } from 'effect'
import { ConfigError } from '../errors.js'
import { envOverrides } from './env-overrides.js'
import { mergeConfig, type Plain } from './merge.js'

export interface FlagOverrides {
  readonly employee?: string | undefined
  readonly branch?: string | undefined
  readonly logLevel?: string | undefined
}

export interface LoadRequest {
  readonly projectPath?: string | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly flags?: FlagOverrides | undefined
}

export interface ConfigIssue {
  readonly file: string
  readonly pointer: string
  readonly message: string
}

export interface ResolvedConfig {
  readonly project: ProjectConfig
  readonly user: UserConfig
  readonly projectPath: string | null
  readonly files: {
    readonly user: string | null
    readonly project: string | null
    readonly local: string | null
  }
}

export interface ConfigShape {
  readonly load: (request: LoadRequest) => Effect.Effect<ResolvedConfig, ConfigError>
  readonly validate: (projectPath: string) => Effect.Effect<readonly ConfigIssue[]>
  readonly schema: () => Record<string, unknown>
}

export class Config extends Context.Service<Config, ConfigShape>()('bb/Config') {}

type ConfigFiles = ResolvedConfig['files']

const BASE = {
  name: 'bytebureau',
  rcFile: false,
  globalRc: false,
  dotenv: false,
  packageJson: false,
  envName: false,
} as const

interface FileLayer {
  readonly config: Plain
  readonly file: string | null
}

const NO_FILE: FileLayer = { config: {}, file: null }

// Unlike a bare name, an exact file name cannot match a release binary or the process directory
function locate(cwd: string, name: string): string | null {
  const candidates = SUPPORTED_EXTENSIONS.map((extension) =>
    path.resolve(cwd, `${name}${extension}`),
  )
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

const loadFile = (file: string): Effect.Effect<FileLayer, ConfigError> =>
  Effect.tryPromise({
    try: async () => {
      const loaded = await loadConfig<Plain>({
        ...BASE,
        cwd: path.dirname(file),
        configFile: path.basename(file),
      })
      return { config: loaded.config, file }
    },
    catch: (cause) => new ConfigError({ file, pointer: '', reason: String(cause) }),
  })

const readLayer = (cwd: string, name: string): Effect.Effect<FileLayer, ConfigError> =>
  Effect.suspend(() => {
    const file = locate(cwd, name)
    return file === null ? Effect.succeed(NO_FILE) : loadFile(file)
  })

// The copy keeps protocol's schema clean: toStandardSchemaV1 attaches ~standard to the schema it receives
const projectStandard = Schema.toStandardSchemaV1(ProjectConfig.annotate({}), {
  parseOptions: { onExcessProperty: 'error', errors: 'all' },
})

type IssuePath = readonly (PropertyKey | { readonly key: PropertyKey })[]

const escapeSegment = (segment: string): string =>
  segment.replaceAll('~', '~0').replaceAll('/', '~1')

// RFC 6901: the document itself is the empty pointer
const pointerOf = (segments: IssuePath = []): string =>
  segments
    .map(
      (segment) => `/${escapeSegment(String(typeof segment === 'object' ? segment.key : segment))}`,
    )
    .join('')

interface Checked {
  readonly project: ProjectConfig | undefined
  readonly issues: readonly ConfigIssue[]
}

const checkProject = (input: unknown, file: string): Effect.Effect<Checked> =>
  Effect.promise(async () => {
    const result = await projectStandard['~standard'].validate(input)
    if (result.issues === undefined) {
      return { project: result.value, issues: [] }
    }
    const issues = result.issues.map((issue) => ({
      file,
      pointer: pointerOf(issue.path),
      message: issue.message,
    }))
    return { project: undefined, issues }
  })

function configErrorOf(file: string, issues: readonly ConfigIssue[]): ConfigError {
  const [first] = issues
  return new ConfigError({
    file,
    pointer: first === undefined ? '' : first.pointer,
    reason: issues.map((issue) => `${issue.pointer}: ${issue.message}`).join('; '),
  })
}

const decodeUser = (user: Plain, file: string): Effect.Effect<UserConfig, ConfigError> =>
  Effect.try({
    try: () => decodeUserConfig(user),
    catch: (cause) => new ConfigError({ file, pointer: '', reason: String(cause) }),
  })

const defaultsFor = (projectPath: string | null): Plain => ({
  ...defaultProjectConfig,
  project: {
    ...defaultProjectConfig.project,
    name: projectPath === null ? 'default' : path.basename(projectPath),
  },
})

// Only the sections user and project configuration share take part in the project layering
const sharedWithProject = (user: Plain): Plain => ({ logging: user['logging'] })

// Undefined values are skipped by mergeConfig, so an absent flag leaves the lower layers untouched
const flagOverrides = (flags: FlagOverrides): Plain => ({
  logging: { level: flags.logLevel },
  defaults: { employee: flags.employee, branch: flags.branch },
})

// Lowest priority first
function mergeLayers(layers: readonly Plain[]): Plain {
  let merged: Plain = {}
  for (const layer of layers) {
    merged = mergeConfig(merged, layer)
  }
  return merged
}

interface Assembled {
  readonly merged: Plain
  readonly user: Plain
  readonly projectPath: string | null
  readonly files: ConfigFiles
}

const assemble = (home: string, request: LoadRequest): Effect.Effect<Assembled, ConfigError> =>
  Effect.gen(function* assembleLayers() {
    const projectPath = request.projectPath === undefined ? null : path.resolve(request.projectPath)
    const userLayer = yield* readLayer(home, 'config')
    const projectLayer =
      projectPath === null ? NO_FILE : yield* readLayer(projectPath, 'bytebureau')
    const localLayer =
      projectPath === null ? NO_FILE : yield* readLayer(projectPath, 'bytebureau.local')
    const merged = mergeLayers([
      defaultsFor(projectPath),
      sharedWithProject(userLayer.config),
      projectLayer.config,
      localLayer.config,
      envOverrides(request.env ?? {}),
      flagOverrides(request.flags ?? {}),
    ])
    const files = { user: userLayer.file, project: projectLayer.file, local: localLayer.file }
    return { merged, user: userLayer.config, projectPath, files }
  })

// Issues are attributed to the file with the highest priority; without one, to the defaults
const issueFile = (files: ConfigFiles, fallback: string): string =>
  files.local ?? files.project ?? fallback

const resolveConfig = (
  home: string,
  request: LoadRequest,
): Effect.Effect<ResolvedConfig, ConfigError> =>
  Effect.gen(function* resolveLayers() {
    const { merged, user, projectPath, files } = yield* assemble(home, request)
    const userConfig = yield* decodeUser(user, files.user ?? path.join(home, 'config.json'))
    const file = issueFile(files, '(defaults)')
    const checked = yield* checkProject(merged, file)
    if (checked.project === undefined) {
      return yield* configErrorOf(file, checked.issues)
    }
    return { project: checked.project, user: userConfig, projectPath, files }
  })

// An unreadable or malformed file becomes an issue, not an empty document blamed for missing keys
const validateConfig = (
  home: string,
  projectPath: string,
): Effect.Effect<readonly ConfigIssue[]> => {
  const root = path.resolve(projectPath)
  return Effect.gen(function* validateLayers() {
    const { merged, files } = yield* assemble(home, { projectPath: root })
    const checked = yield* checkProject(
      merged,
      issueFile(files, path.join(root, 'bytebureau.json')),
    )
    return checked.issues
  }).pipe(
    Effect.catchTag('ConfigError', (failure) =>
      Effect.succeed([{ file: failure.file, pointer: failure.pointer, message: failure.reason }]),
    ),
  )
}

const make = (home: string): ConfigShape => ({
  load: (request) => resolveConfig(home, request),
  validate: (projectPath) => validateConfig(home, projectPath),
  schema: configJsonSchema,
})

export const ConfigLive = (home: string): Layer.Layer<Config> =>
  Layer.succeed(Config, Config.of(make(home)))
