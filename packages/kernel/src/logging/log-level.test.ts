import type { LogRecord } from '@logtape/logtape'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  configureLogging,
  EffectLoggerLive,
  EffectLogLevelLive,
  parseLogLevel,
  resetLogging,
  type KernelLogLevel,
} from './logging.js'

const SEVERITIES = [
  Effect.logTrace('trace'),
  Effect.logDebug('debug'),
  Effect.logInfo('info'),
  Effect.logWarning('warn'),
  Effect.logError('error'),
]

// One record of each severity, logged by Effect under the level; LogTape itself lets everything through
async function reached(level: KernelLogLevel): Promise<readonly unknown[]> {
  const seen: LogRecord[] = []
  await configureLogging({
    level: 'trace',
    json: true,
    capture: (record) => {
      seen.push(record)
    },
  })
  try {
    const logging = Effect.all(SEVERITIES, { discard: true })
    const layer = Layer.mergeAll(EffectLoggerLive, EffectLogLevelLive(level))
    await Effect.runPromise(Effect.provide(logging, layer))
  } finally {
    await resetLogging()
  }
  return seen.map((record) => record.message[0])
}

describe(EffectLogLevelLive, () => {
  it.each<[KernelLogLevel, readonly string[]]>([
    ['trace', ['trace', 'debug', 'info', 'warn', 'error']],
    ['debug', ['debug', 'info', 'warn', 'error']],
    ['info', ['info', 'warn', 'error']],
    ['warn', ['warn', 'error']],
    ['error', ['error']],
  ])('at %s lets Effect log from that level up', async (level, delivered) => {
    expect.hasAssertions()
    await expect(reached(level)).resolves.toStrictEqual(delivered)
  })
})

describe(parseLogLevel, () => {
  it.each<KernelLogLevel>(['trace', 'debug', 'info', 'warn', 'error'])('keeps %s', (level) => {
    expect(parseLogLevel(level)).toBe(level)
  })

  it.each([undefined, '', 'verbose', 'DEBUG', 'warning'])('takes %j for info', (level) => {
    expect(parseLogLevel(level)).toBe('info')
  })
})
