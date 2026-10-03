import {
  ansiColorFormatter,
  configure,
  getLogger,
  jsonLinesFormatter,
  reset,
  type LoggerConfig,
  type LogLevel,
  type LogRecord,
  type Sink,
  type TextFormatter,
} from '@logtape/logtape'
import { getRotatingFileSink } from '@logtape/file'
import type { Logger as PluginLogger } from '@bytebureau/plugin-api'
import { Cause, Layer, Logger, References, type LogLevel as EffectLogLevel } from 'effect'
import { redactFields, redactText } from './redaction.js'

export type KernelLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export interface LoggingOptions {
  readonly level: KernelLogLevel
  readonly json: boolean
  readonly debug?: string | undefined
  readonly file?: string | undefined
  readonly capture?: ((record: LogRecord) => void) | undefined
}

// A level that is missing or unknown is info, so a mistyped flag never silences the kernel
export function parseLogLevel(level: string | undefined): KernelLogLevel {
  if (
    level === 'trace' ||
    level === 'debug' ||
    level === 'info' ||
    level === 'warn' ||
    level === 'error'
  ) {
    return level
  }
  return 'info'
}

const toLogTape = (level: KernelLogLevel): LogLevel => (level === 'warn' ? 'warning' : level)

// --debug lets the categories it selects log at debug, so Effect's own minimum has to let debug records through to them
export const effectLevelOf = (level: KernelLogLevel, debug: string | undefined): KernelLogLevel =>
  debug === undefined || level === 'trace' ? level : 'debug'

interface DebugSelection {
  readonly enabled: readonly string[][]
  readonly silenced: readonly string[][]
}

const NO_DEBUG: DebugSelection = { enabled: [], silenced: [] }

type CategoryConfig = LoggerConfig<string, string>

// `--debug` with no list enables every bb.* category; `a,!b` enables a and silences b
export function parseDebug(debug: string | undefined): DebugSelection | undefined {
  if (debug === undefined) {
    return undefined
  }
  if (debug === '' || debug === 'true') {
    return { enabled: [['bb']], silenced: [] }
  }
  const items = debug
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  return {
    enabled: items.filter((item) => !item.startsWith('!')).map((item) => item.split('.')),
    silenced: items.filter((item) => item.startsWith('!')).map((item) => item.slice(1).split('.')),
  }
}

// Every record goes to stderr, whatever its level: stdout belongs to the output of a command, such as the NDJSON of --json
const stderrSink =
  (formatter: TextFormatter): Sink =>
  (record) => {
    process.stderr.write(formatter(record))
  }

function sinks(options: LoggingOptions): Record<string, Sink> {
  const result: Record<string, Sink> = {
    console: redactFields(
      stderrSink(options.json ? redactText(jsonLinesFormatter) : redactText(ansiColorFormatter)),
    ),
  }
  if (options.file !== undefined) {
    result['file'] = redactFields(
      getRotatingFileSink(options.file, {
        maxSize: 20 * 1024 * 1024,
        maxFiles: 5,
        formatter: redactText(jsonLinesFormatter),
      }),
    )
  }
  if (options.capture !== undefined) {
    result['capture'] = redactFields(options.capture)
  }
  return result
}

// Keyed by category so a repeated or bb-rooted selection replaces an entry; negations come last and win
function categoryConfigs(options: LoggingOptions, sinkIds: string[]): CategoryConfig[] {
  const { enabled, silenced } = parseDebug(options.debug) ?? NO_DEBUG
  const configs = new Map<string, CategoryConfig>([
    ['bb', { category: ['bb'], sinks: sinkIds, lowestLevel: toLogTape(options.level) }],
  ])
  for (const category of enabled) {
    configs.set(category.join('.'), {
      category,
      sinks: sinkIds,
      parentSinks: 'override',
      lowestLevel: 'debug',
    })
  }
  for (const category of silenced) {
    configs.set(category.join('.'), {
      category,
      sinks: [],
      parentSinks: 'override',
      lowestLevel: 'fatal',
    })
  }
  // The kernel configures the meta logger itself
  configs.delete('logtape.meta')
  return [...configs.values()]
}

export async function configureLogging(options: LoggingOptions): Promise<void> {
  const allSinks = sinks(options)
  await configure({
    reset: true,
    sinks: allSinks,
    loggers: [
      // Without an explicit entry LogTape gives the meta logger a default console sink that skips the redaction
      { category: ['logtape', 'meta'], sinks: ['console'], lowestLevel: 'warning' },
      ...categoryConfigs(options, Object.keys(allSinks)),
    ],
  })
}

export async function resetLogging(): Promise<void> {
  await reset()
}

const levelMap: Record<EffectLogLevel.LogLevel, LogLevel | undefined> = {
  All: 'trace',
  Trace: 'trace',
  Debug: 'debug',
  Info: 'info',
  Warn: 'warning',
  Error: 'error',
  Fatal: 'fatal',
  None: undefined,
}

const toParts = (message: unknown): readonly unknown[] =>
  Array.isArray(message) ? message : [message]

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const prototype = Reflect.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

// Parts that are not strings become properties, so the field redaction sees them: one plain object is merged, the rest go under `parts`
function partProperties(parts: readonly unknown[]): Record<string, unknown> {
  const [only] = parts
  if (parts.length === 1 && isPlainRecord(only)) {
    return only
  }
  return parts.length > 0 ? { parts } : {}
}

// A bridged record carries one literal message part that is never a placeholder; the raw template's braces are escaped
const literalMessage = (text: string): Pick<LogRecord, 'message' | 'rawMessage'> => ({
  message: [text],
  rawMessage: text.replaceAll('{', '{{').replaceAll('}', '}}'),
})

// Effect logger → LogTape: the category annotation picks the logger, the other annotations and the non-string parts become properties
export const effectToLogTape: Logger.Logger<unknown, void> = Logger.make((options) => {
  const level = levelMap[options.logLevel]
  if (level === undefined) {
    return
  }
  const { category, ...annotations } = options.fiber.getRef(References.CurrentLogAnnotations)
  const parts = toParts(options.message)
  const text = parts.filter((part) => typeof part === 'string').join(' ')
  const properties: Record<string, unknown> = {
    ...annotations,
    ...partProperties(parts.filter((part) => typeof part !== 'string')),
  }
  if (options.cause.reasons.length > 0) {
    properties['cause'] = Cause.pretty(options.cause)
  }
  getLogger(typeof category === 'string' ? category.split('.') : ['bb', 'core']).emit({
    timestamp: options.date.getTime(),
    level,
    properties,
    ...literalMessage(text),
  })
})

export const EffectLoggerLive: Layer.Layer<never> = Logger.layer([effectToLogTape])

const effectLevels: Record<KernelLogLevel, EffectLogLevel.LogLevel> = {
  trace: 'Trace',
  debug: 'Debug',
  info: 'Info',
  warn: 'Warn',
  error: 'Error',
}

// Effect drops a record below its minimum level before any logger sees it, so the kernel's level has to reach it too
export const EffectLogLevelLive = (level: KernelLogLevel): Layer.Layer<never> =>
  Layer.succeed(References.MinimumLogLevel, effectLevels[level])

export function kernelLogger(category: readonly string[]): PluginLogger {
  const logger = getLogger(category)
  const log =
    (level: LogLevel) =>
    (message: string, properties?: Readonly<Record<string, unknown>>): void => {
      if (logger.isEnabledFor(level)) {
        logger.emit({
          timestamp: Date.now(),
          level,
          properties: properties ?? {},
          ...literalMessage(message),
        })
      }
    }
  return {
    category,
    debug: log('debug'),
    info: log('info'),
    warn: log('warning'),
    error: log('error'),
    child: (name) => kernelLogger([...category, name]),
  }
}
