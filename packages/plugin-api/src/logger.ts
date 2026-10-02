export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  readonly category: readonly string[]
  debug(message: string, properties?: Readonly<Record<string, unknown>>): void
  info(message: string, properties?: Readonly<Record<string, unknown>>): void
  warn(message: string, properties?: Readonly<Record<string, unknown>>): void
  error(message: string, properties?: Readonly<Record<string, unknown>>): void
  child(name: string): Logger
}
