export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  readonly category: readonly string[]
  readonly debug: (message: string, properties?: Readonly<Record<string, unknown>>) => void
  readonly info: (message: string, properties?: Readonly<Record<string, unknown>>) => void
  readonly warn: (message: string, properties?: Readonly<Record<string, unknown>>) => void
  readonly error: (message: string, properties?: Readonly<Record<string, unknown>>) => void
  readonly child: (name: string) => Logger
}
