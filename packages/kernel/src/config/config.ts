import path from 'node:path'
import {
  configJsonSchema,
  defaultProjectConfig,
  type ProjectConfig,
  type UserConfig,
} from '@bytebureau/protocol'
import { Context, Effect, Layer } from 'effect'
import type { ConfigError } from '../errors.js'
import { envOverrides } from './env-overrides.js'
import { readLayer, requireDirectory, type LoadedFile } from './files.js'
import { checkProject, checkUser, configErrorOf, distinct, type ConfigIssue } from './issues.js'
import { mergeLayers, type ConfigLayer, type Plain } from './merge.js'

export type { ConfigIssue } from './issues.js'

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
  // The environment layer takes part as in load, so an issue can name the variable it comes from
  readonly validate: (
    projectPath: string,
    env?: LoadRequest['env'],
  ) => Effect.Effect<readonly ConfigIssue[]>
  readonly schema: () => Record<string, unknown>
  // Where the user configuration goes when the home holds none yet
  readonly userFile: string
}

export class Config extends Context.Service<Config, ConfigShape>()('bb/Config') {}

const FLAG_PATHS = [
  ['logLevel', 'logging', 'level'],
  ['employee', 'defaults', 'employee'],
  ['branch', 'defaults', 'branch'],
] as const

// One layer per flag that is set, so an issue can name the flag it comes from
const flagLayers = (flags: FlagOverrides): readonly ConfigLayer[] =>
  FLAG_PATHS.flatMap(([flag, section, key]) => {
    const value = flags[flag]
    return value === undefined
      ? []
      : [{ label: `flag:${flag}`, config: { [section]: { [key]: value } }, fromFile: false }]
  })

const defaultsLayer = (projectPath: string | null): ConfigLayer => {
  const defaults = structuredClone(defaultProjectConfig)
  const name = projectPath === null ? 'default' : path.basename(projectPath)
  return {
    label: '(defaults)',
    config: { ...defaults, project: { ...defaults.project, name } },
    fromFile: false,
  }
}

const whole = (config: Plain): Plain => config

// Only the sections user and project configuration share take part in the project layering
const sharedWithProject = (user: Plain): Plain =>
  user['logging'] === undefined ? {} : { logging: user['logging'] }

const fileLayer = (
  loaded: LoadedFile | null,
  section: (config: Plain) => Plain,
): readonly ConfigLayer[] =>
  loaded === null ? [] : [{ label: loaded.file, config: section(loaded.config), fromFile: true }]

const fileOf = (loaded: LoadedFile | null): string | null => (loaded === null ? null : loaded.file)

interface Assembled {
  readonly layers: readonly ConfigLayer[]
  readonly user: Plain
  readonly projectPath: string | null
  readonly files: ResolvedConfig['files']
}

// Lowest priority first: defaults, user, project, local, environment, flags
const assemble = (home: string, request: LoadRequest): Effect.Effect<Assembled, ConfigError> =>
  Effect.gen(function* assembleLayers() {
    const projectPath = request.projectPath === undefined ? null : path.resolve(request.projectPath)
    if (projectPath !== null) {
      yield* requireDirectory(projectPath)
    }
    const user = yield* readLayer(home, 'config')
    const project = projectPath === null ? null : yield* readLayer(projectPath, 'bytebureau')
    const local = projectPath === null ? null : yield* readLayer(projectPath, 'bytebureau.local')
    const layers = [
      defaultsLayer(projectPath),
      ...fileLayer(user, sharedWithProject),
      ...fileLayer(project, whole),
      ...fileLayer(local, whole),
      ...envOverrides(request.env ?? {}),
      ...flagLayers(request.flags ?? {}),
    ]
    const files = { user: fileOf(user), project: fileOf(project), local: fileOf(local) }
    return { layers, user: user === null ? {} : user.config, projectPath, files }
  })

interface Inspected {
  readonly projectPath: string | null
  readonly files: ResolvedConfig['files']
  readonly user: UserConfig | undefined
  readonly project: ProjectConfig | undefined
  readonly issues: readonly ConfigIssue[]
}

// The user file is checked against its own schema, the layers merged against the project schema
const inspect = (home: string, request: LoadRequest): Effect.Effect<Inspected, ConfigError> =>
  Effect.gen(function* inspectLayers() {
    const { layers, user, projectPath, files } = yield* assemble(home, request)
    const checkedUser = yield* checkUser(user, files.user ?? path.join(home, 'config.json'))
    const fallback = files.project ?? '(defaults)'
    const checkedProject = yield* checkProject(mergeLayers(layers), layers, fallback)
    const issues = distinct([...checkedUser.issues, ...checkedProject.issues])
    return {
      projectPath,
      files,
      user: checkedUser.value,
      project: checkedProject.value,
      issues,
    }
  })

const resolveConfig = (
  home: string,
  request: LoadRequest,
): Effect.Effect<ResolvedConfig, ConfigError> =>
  Effect.gen(function* resolveLayers() {
    const { projectPath, files, user, project, issues } = yield* inspect(home, request)
    if (user === undefined || project === undefined) {
      return yield* configErrorOf(issues)
    }
    return { project, user, projectPath, files }
  })

// A file that cannot be read or parsed is one issue, not an empty document blamed for missing keys
const validateConfig = (
  home: string,
  request: LoadRequest,
): Effect.Effect<readonly ConfigIssue[]> =>
  inspect(home, request).pipe(
    Effect.map((inspected) => inspected.issues),
    Effect.catchTag('ConfigError', (failure) =>
      Effect.succeed([{ file: failure.file, pointer: failure.pointer, message: failure.reason }]),
    ),
  )

const make = (home: string): ConfigShape => ({
  load: (request) => resolveConfig(home, request),
  validate: (projectPath, env = {}) => validateConfig(home, { projectPath, env }),
  schema: configJsonSchema,
  userFile: path.join(home, 'config.json'),
})

export const ConfigLive = (home: string): Layer.Layer<Config> =>
  Layer.succeed(Config, Config.of(make(home)))
