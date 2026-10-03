import { isPlain, type Plain } from './merge.js'

// Explicit map: environment variable → config path (dotted); extend deliberately, never generically
const ENV_MAP: readonly (readonly [string, string])[] = [
  ['BYTEBUREAU_LOG_LEVEL', 'logging.level'],
  ['BYTEBUREAU_EMPLOYEE', 'defaults.employee'],
  ['BYTEBUREAU_BRANCH', 'defaults.branch'],
  ['BYTEBUREAU_WORKSPACE_RUNTIME', 'workspace.runtime'],
]

function assign(target: Plain, dotted: string, value: string): void {
  const keys = dotted.split('.')
  let cursor = target
  for (const key of keys.slice(0, -1)) {
    const next = cursor[key]
    const section: Plain = isPlain(next) ? next : {}
    cursor[key] = section
    cursor = section
  }
  cursor[keys.at(-1) ?? ''] = value
}

export function envOverrides(env: Readonly<Record<string, string | undefined>>): Plain {
  const result: Plain = {}
  for (const [name, dotted] of ENV_MAP) {
    const value = env[name]
    if (value !== undefined && value !== '') {
      assign(result, dotted, value)
    }
  }
  return result
}
