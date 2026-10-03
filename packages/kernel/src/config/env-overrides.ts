import type { ConfigLayer, Plain } from './merge.js'

// Explicit map: environment variable → config path (dotted); extend deliberately, never generically
const ENV_MAP: readonly (readonly [string, string])[] = [
  ['BYTEBUREAU_LOG_LEVEL', 'logging.level'],
  ['BYTEBUREAU_EMPLOYEE', 'defaults.employee'],
  ['BYTEBUREAU_BRANCH', 'defaults.branch'],
  ['BYTEBUREAU_WORKSPACE_RUNTIME', 'workspace.runtime'],
]

// 'logging.level' and 'info' make { logging: { level: 'info' } }
function nest(dotted: string, value: string): Plain {
  const keys = dotted.split('.')
  const result: Plain = {}
  let cursor = result
  for (const key of keys.slice(0, -1)) {
    const section: Plain = {}
    cursor[key] = section
    cursor = section
  }
  cursor[keys.at(-1) ?? ''] = value
  return result
}

// One layer per variable that is set, so an issue can name the variable it comes from
export function envOverrides(
  env: Readonly<Record<string, string | undefined>>,
): readonly ConfigLayer[] {
  return ENV_MAP.flatMap(([name, dotted]) => {
    const value = env[name]
    if (value === undefined || value === '') {
      return []
    }
    return [{ label: `env:${name}`, config: nest(dotted, value), fromFile: false }]
  })
}
