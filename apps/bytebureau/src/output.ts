import { createColors } from 'picocolors'

type Colors = ReturnType<typeof createColors>

export interface OutputOptions {
  readonly json: boolean
  readonly color: boolean
}

export interface Output {
  readonly json: boolean
  readonly colors: Colors
  readonly print: (text: string) => void
  readonly emit: (record: Record<string, unknown>) => void
  readonly warn: (text: string) => void
}

export function colorEnabled(
  env: Readonly<Record<string, string | undefined>>,
  noColorFlag: boolean,
  isTTY: boolean,
): boolean {
  if (noColorFlag || env['NO_COLOR'] !== undefined) {
    return false
  }
  const force = env['FORCE_COLOR']
  if (force !== undefined && force !== '0') {
    return true
  }
  return isTTY
}

export function createOutput({ json, color }: OutputOptions): Output {
  const colors: Colors = createColors(color)
  return {
    json,
    colors,
    print(text) {
      if (!json) {
        console.log(text)
      }
    },
    emit(record) {
      if (json) {
        console.log(JSON.stringify(record))
      }
    },
    warn(text) {
      console.error(json ? JSON.stringify({ level: 'warn', message: text }) : text)
    },
  }
}
