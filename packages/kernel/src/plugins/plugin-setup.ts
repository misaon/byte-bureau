import type { Plugin, PluginRegistration } from '@bytebureau/plugin-api'
import { HOST_API_VERSION } from './bundled.js'
import { createPluginContext, type ContextDeps } from './plugin-context.js'
import { satisfiesMajor } from './semver-major.js'

type Path = readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined

// Dotted keys of an issue, a nested one too; the empty text for an issue about the whole config
const dotted = (path: Path): string =>
  (path ?? [])
    .map((segment) => String(typeof segment === 'object' ? segment.key : segment))
    .join('.')

const describeIssue = (path: Path, message: string): string => {
  const where = dotted(path)
  return where === '' ? message : `${where} ${message}`
}

// A plugin without a schema gets its config as it is; one with a schema gets what the schema makes of it, {} when there is none
async function validateConfig(plugin: Plugin, config: unknown): Promise<unknown> {
  const schema = plugin.manifest.config
  if (schema === undefined) {
    return config
  }
  const result = await schema['~standard'].validate(config ?? {})
  if (result.issues !== undefined) {
    const issues = result.issues.map((issue) => describeIssue(issue.path, issue.message))
    throw new Error(`config invalid: ${issues.join('; ')}`)
  }
  return result.value
}

// A plugin written in plain JavaScript may forget to return its registration
const isRegistration = (value: unknown): value is PluginRegistration =>
  typeof value === 'object' && value !== null

// Everything that can refuse a plugin: the host API gate, its config and its own setup
export async function setUpPlugin(
  plugin: Plugin,
  config: unknown,
  deps: ContextDeps,
): Promise<PluginRegistration> {
  const { name, hostApi } = plugin.manifest
  if (!satisfiesMajor(hostApi, HOST_API_VERSION)) {
    throw new Error(
      `plugin ${name} needs host API ${hostApi}, this ByteBureau provides ${HOST_API_VERSION}`,
    )
  }
  const validated = await validateConfig(plugin, config)
  const registration: unknown = await plugin.setup(createPluginContext(name, validated, deps))
  if (!isRegistration(registration)) {
    throw new Error(`plugin ${name} returned no registration from setup`)
  }
  return registration
}
