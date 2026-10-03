import { inspect } from 'node:util'
import {
  ansiColorFormatter,
  configure,
  getConsoleSink,
  getLogger,
  jsonLinesFormatter,
  reset,
  type LoggerConfig,
  type LogLevel,
  type LogRecord,
  type Sink,
} from '@logtape/logtape'
import { getRotatingFileSink } from '@logtape/file'
import type { Logger as PluginLogger } from '@bytebureau/plugin-api'
import { Cause, Logger, References, type Layer, type LogLevel as EffectLogLevel } from 'effect'
import { redactFields, redactText } from './redaction.js'

export type KernelLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export interface LoggingOptions {
  readonly level: KernelLogLevel
  readonly json: boolean
  readonly debug?: string | undefined
  readonly file?: string | undefined
  readonly capture?: ((record: LogRecord) => void) | undefined
}

const toLogTape = (level: KernelLogLevel): LogLevel => (level === 'warn' ? 'warning' : level)

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

function sinks(options: LoggingOptions): Record<string, Sink> {
  const result: Record<string, Sink> = {
    console: redactFields(
      getConsoleSink({
        formatter: options.json ? redactText(jsonLinesFormatter) : redactText(ansiColorFormatter),
      }),
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

export async function configureLogging(options: LoggingOptions): Promise<void> {
  const allSinks = sinks(options)
  const sinkIds = Object.keys(allSinks)
  const { enabled, silenced } = parseDebug(options.debug) ?? NO_DEBUG
  await configure({
    reset: true,
    sinks: allSinks,
    loggers: [
      { category: ['logtape', 'meta'], sinks: ['console'], lowestLevel: 'warning' },
      { category: ['bb'], sinks: sinkIds, lowestLevel: toLogTape(options.level) },
      ...enabled.map((category): CategoryConfig => ({
        category,
        sinks: sinkIds,
        parentSinks: 'override',
        lowestLevel: 'debug',
      })),
      ...silenced.map((category): CategoryConfig => ({
        category,
        sinks: [],
        parentSinks: 'override',
        lowestLevel: 'fatal',
      })),
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

const asText = (part: unknown): string =>
  typeof part === 'string' ? part : inspect(part, { depth: 3 })

const toParts = (message: unknown): readonly unknown[] =>
  Array.isArray(message) ? message : [message]

// A bridged record carries one literal message part that is never a placeholder; the raw template's braces are escaped
const literalMessage = (text: string): Pick<LogRecord, 'message' | 'rawMessage'> => ({
  message: [text],
  rawMessage: text.replaceAll('{', '{{').replaceAll('}', '}}'),
})

// Effect logger → LogTape: the category annotation picks the logger, the other annotations become properties
export const effectToLogTape: Logger.Logger<unknown, void> = Logger.make((options) => {
  const level = levelMap[options.logLevel]
  if (level === undefined) {
    return
  }
  const { category, ...annotations } = options.fiber.getRef(References.CurrentLogAnnotations)
  const text = toParts(options.message)
    .map((part) => asText(part))
    .join(' ')
  const properties: Record<string, unknown> = { ...annotations }
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
