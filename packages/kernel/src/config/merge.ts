export type Plain = Record<string, unknown>

// One source of configuration: the defaults, a file, an environment variable or a flag
export interface ConfigLayer {
  readonly label: string
  readonly config: Plain
  readonly fromFile: boolean
}

export const isPlain = (value: unknown): value is Plain =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const sectionOf = (value: unknown): Plain => (isPlain(value) ? value : {})

const ownValue = (record: Plain, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : undefined

// Deep merge where the overlay wins; arrays and scalars replace, undefined is skipped at every depth
// Keys are defined, not assigned: a "__proto__" key stays a key that validation reports, it never becomes a prototype
export function mergeConfig(base: Plain, overlay: Plain): Plain {
  const result: Plain = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    if (value !== undefined) {
      const merged = isPlain(value) ? mergeConfig(sectionOf(ownValue(result, key)), value) : value
      Reflect.defineProperty(result, key, {
        value: merged,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
  }
  return result
}

// Lowest priority first
export function mergeLayers(layers: readonly ConfigLayer[]): Plain {
  let merged: Plain = {}
  for (const layer of layers) {
    merged = mergeConfig(merged, layer.config)
  }
  return merged
}
