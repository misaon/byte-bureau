import type { Plugin } from '@bytebureau/plugin-api'

// A plugin name is a kebab-case word: it becomes a logger category, a kv namespace and a secrets prefix, where a dot or a slash would collide
const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]*$/u

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null

const textOf = (record: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

// The name and the version a plugin claims, whatever shape it has; a status needs them even for a refusal
export interface Identity {
  readonly name: string
  readonly version: string
}

const manifestOf = (plugin: unknown): Readonly<Record<string, unknown>> | undefined => {
  const manifest = isRecord(plugin) ? plugin['manifest'] : undefined
  return isRecord(manifest) ? manifest : undefined
}

export const identityOf = (plugin: unknown): Identity => {
  const manifest = manifestOf(plugin)
  return {
    name: (manifest === undefined ? undefined : textOf(manifest, 'name')) ?? '(unnamed)',
    version: (manifest === undefined ? undefined : textOf(manifest, 'version')) ?? '',
  }
}

// What keeps a plugin from being set up at all; a plugin written in plain JavaScript can be any value
export function shapeProblem(plugin: Plugin): string | undefined {
  const manifest = manifestOf(plugin)
  if (manifest === undefined || typeof Reflect.get(plugin, 'setup') !== 'function') {
    return 'a plugin needs a manifest object and a setup function'
  }
  const missing = ['name', 'version', 'hostApi'].filter(
    (key) => textOf(manifest, key) === undefined,
  )
  if (missing.length > 0) {
    return `the manifest has no ${missing.join(', ')}`
  }
  const name = textOf(manifest, 'name') ?? ''
  if (!PLUGIN_NAME.test(name)) {
    return `the plugin name ${name} is not lower-case letters, digits and dashes`
  }
  // A name every object inherits, such as constructor, breaks the logger tree of LogTape
  return Object.hasOwn(Object.prototype, name) ? `the plugin name ${name} is reserved` : undefined
}
