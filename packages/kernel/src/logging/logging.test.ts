import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getLogger, type LogRecord } from '@logtape/logtape'
import { Cause, Effect, Layer, type LogLevel, References } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import {
  configureLogging,
  EffectLoggerLive,
  effectToLogTape,
  kernelLogger,
  parseDebug,
  resetLogging,
  type LoggingOptions,
} from './logging.js'

// LogTape's configuration is global: each test configures it, runs its logging, collects the records and resets
async function captured(
  options: Omit<LoggingOptions, 'capture'>,
  logging: Effect.Effect<void>,
): Promise<readonly LogRecord[]> {
  const seen: LogRecord[] = []
  await configureLogging({
    ...options,
    capture: (entry) => {
      seen.push(entry)
    },
  })
  try {
    const layer = Layer.mergeAll(
      EffectLoggerLive,
      Layer.succeed(References.MinimumLogLevel, 'Debug'),
    )
    await Effect.runPromise(Effect.provide(logging, layer))
  } finally {
    await resetLogging()
  }
  return seen
}

const LEVELS: readonly LogLevel.LogLevel[] = [
  'All',
  'Trace',
  'Debug',
  'Info',
  'Warn',
  'Error',
  'Fatal',
  'None',
]

async function sinkOutputs(): Promise<readonly string[]> {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-logging-'))
  const file = path.join(dir, 'kernel.log')
  const info = vi.spyOn(console, 'info').mockReturnValue()
  try {
    await captured(
      { level: 'info', json: true, file },
      Effect.sync(() => {
        kernelLogger(['bb', 'sinks']).info('key sk-ant-api03-canary', {
          apiKey: 'field-only-value',
          keep: 1,
        })
      }),
    )
    return [readFileSync(file, 'utf8'), ...info.mock.calls.map((call) => String(call[0]))]
  } finally {
    info.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  }
}

async function failingSinkRun(): Promise<{
  readonly delivered: readonly unknown[]
  readonly reported: readonly string[]
}> {
  const capture = vi.fn<(record: LogRecord) => void>().mockImplementationOnce(() => {
    throw new Error('sink boom')
  })
  const error = vi.spyOn(console, 'error').mockReturnValue()
  try {
    await configureLogging({ level: 'info', json: true, capture })
    const logger = kernelLogger(['bb', 'sinks'])
    logger.info('first')
    logger.info('second')
    return {
      delivered: capture.mock.calls.map(([entry]) => entry.message[0]),
      reported: error.mock.calls.map((call) => String(call[0])),
    }
  } finally {
    await resetLogging()
    error.mockRestore()
  }
}

async function debugDelivery(debug: string): Promise<readonly unknown[]> {
  const seen = await captured(
    { level: 'info', json: true, debug },
    Effect.sync(() => {
      getLogger(['bb', 'core']).debug('core debug')
      getLogger(['bb', 'core']).info('core info')
      getLogger(['bb', 'store']).debug('store debug')
      getLogger(['bb', 'store']).info('store info')
      getLogger(['bb', 'agent']).debug('agent debug')
    }),
  )
  return seen.map((entry) => entry.message[0])
}

describe('effect bridge', () => {
  it('routes Effect logs into LogTape categories with annotations as properties', async () => {
    expect.hasAssertions()
    const seen = await captured(
      { level: 'debug', json: true },
      Effect.logDebug('from effect').pipe(
        Effect.annotateLogs({ category: 'bb.store', sessionId: 's1' }),
      ),
    )
    expect(
      seen.map((entry) => [entry.category.join('.'), entry.level, entry.message[0]]),
    ).toStrictEqual([['bb.store', 'debug', 'from effect']])
    expect(seen.map((entry) => entry.properties)).toMatchObject([{ sessionId: 's1' }])
  })

  it('keeps string parts literal and merges one object part into the properties, in bb.core by default', async () => {
    expect.hasAssertions()
    const seen = await captured(
      { level: 'info', json: true },
      Effect.logInfo('literal {name} }} {{x}}', { count: 1 }),
    )
    expect(
      seen.map((entry) => [entry.category.join('.'), entry.message[0], entry.properties]),
    ).toStrictEqual([['bb.core', 'literal {name} }} {{x}}', { count: 1 }]])
  })
})

describe('effect message parts', () => {
  it('puts object parts through the field redaction, leaving no canary in text or properties', async () => {
    expect.hasAssertions()
    const seen = await captured(
      { level: 'info', json: true },
      Effect.logInfo('x', {
        password: 'hunter2-canary',
        nested: { authorization: 'Bearer canary' },
      }),
    )
    expect(JSON.stringify(seen)).not.toContain('canary')
    expect(seen.map((entry) => [entry.message, entry.properties])).toStrictEqual([
      [['x'], { nested: {} }],
    ])
  })

  it('stores several, non-object and Error parts under parts, redacted like any property', async () => {
    expect.hasAssertions()
    const logging = Effect.all(
      [
        Effect.logInfo('a', 'b', { token: 'canary', keep: 1 }, 7),
        Effect.logInfo('count', 5),
        Effect.logError('failed', new Error('boom')),
      ],
      { discard: true },
    )
    const seen = await captured({ level: 'info', json: true }, logging)
    expect(seen.map((entry) => [entry.message[0], entry.properties])).toStrictEqual([
      ['a b', { parts: [{ keep: 1 }, 7] }],
      ['count', { parts: [5] }],
      ['failed', { parts: [new Error('boom')] }],
    ])
  })
})

describe('effect logger mapping', () => {
  it('maps every Effect level onto its LogTape level, drops None and stamps the Effect date', async () => {
    expect.hasAssertions()
    const date = new Date('2026-10-02T12:00:00.000Z')
    const seen = await captured(
      { level: 'trace', json: true },
      Effect.withFiber((fiber) =>
        Effect.sync(() => {
          for (const logLevel of LEVELS) {
            effectToLogTape.log({ message: [logLevel], logLevel, cause: Cause.empty, fiber, date })
          }
        }),
      ),
    )
    expect(seen.map((entry) => [entry.message[0], entry.level])).toStrictEqual([
      ['All', 'trace'],
      ['Trace', 'trace'],
      ['Debug', 'debug'],
      ['Info', 'info'],
      ['Warn', 'warning'],
      ['Error', 'error'],
      ['Fatal', 'fatal'],
    ])
    expect(new Set(seen.map((entry) => entry.timestamp))).toStrictEqual(new Set([date.getTime()]))
  })

  it('attaches a failure cause as a pretty-printed property', async () => {
    expect.hasAssertions()
    const seen = await captured(
      { level: 'info', json: true },
      Effect.logError('request failed', Cause.fail('upstream down')),
    )
    expect(seen.map((entry) => entry.message)).toStrictEqual([['request failed']])
    expect(seen.map((entry) => entry.properties['cause'])).toStrictEqual([
      expect.stringContaining('upstream down'),
    ])
  })
})

describe(configureLogging, () => {
  it('applies --debug category selection: listed categories at debug, negated ones silenced', async () => {
    expect.hasAssertions()
    const seen = await captured(
      { level: 'info', json: true, debug: 'bb.agent,!bb.store' },
      Effect.sync(() => {
        getLogger(['bb', 'agent', 'fake']).debug('agent detail')
        getLogger(['bb', 'store']).error('store error')
        getLogger(['bb', 'store']).fatal('store fatal')
        getLogger(['bb', 'store', 'sqlite']).error('sqlite error')
        getLogger(['bb', 'core']).debug('core detail')
      }),
    )
    expect(seen.map((entry) => entry.message[0])).toStrictEqual(['agent detail'])
  })

  it('reports a throwing sink on the console and keeps delivering to it', async () => {
    expect.hasAssertions()
    const { delivered, reported } = await failingSinkRun()
    expect(delivered).toStrictEqual(['first', 'second'])
    expect(reported).toHaveLength(1)
    expect(JSON.parse(reported.join(''))).toMatchObject({
      level: 'FATAL',
      logger: 'logtape.meta',
      properties: { error: { message: 'sink boom' } },
    })
  })

  it('redacts secrets in the console and file output', async () => {
    expect.hasAssertions()
    const outputs = await sinkOutputs()
    expect(outputs).toHaveLength(2)
    for (const output of outputs) {
      expect(output).toContain('"keep":1')
      expect(output).toContain('[REDACTED]')
      expect(output).not.toContain('canary')
      expect(output).not.toContain('field-only-value')
    }
  })
})

describe('debug selections', () => {
  const everything = ['core debug', 'core info', 'store debug', 'store info', 'agent debug']

  it.each<[string, readonly string[]]>([
    ['', everything],
    ['true', everything],
    ['bb,!bb.store', ['core debug', 'core info', 'agent debug']],
    ['bb.agent,!bb.agent', ['core info', 'store info']],
    ['bb.agent,bb.agent,!bb.store,!bb.store', ['core info', 'agent debug']],
    ['logtape.meta', ['core info', 'store info']],
  ])('--debug %j delivers %j', async (debug, delivered) => {
    expect.hasAssertions()
    await expect(debugDelivery(debug)).resolves.toStrictEqual(delivered)
  })
})

describe(kernelLogger, () => {
  it('logs the text literally at the mapped level under the child category, minus secret fields', async () => {
    expect.hasAssertions()
    const seen = await captured(
      { level: 'warn', json: true },
      Effect.sync(() => {
        const logger = kernelLogger(['bb', 'plugin']).child('demo')
        logger.info('dropped below the configured level')
        logger.warn('closing } missing', { count: 1, apiKey: 'field-only-value' })
        logger.error('hello {name}', { name: 'N' })
      }),
    )
    expect(
      seen.map((entry) => [entry.category.join('.'), entry.level, entry.message[0]]),
    ).toStrictEqual([
      ['bb.plugin.demo', 'warning', 'closing } missing'],
      ['bb.plugin.demo', 'error', 'hello {name}'],
    ])
    expect(seen.map((entry) => entry.properties)).toStrictEqual([{ count: 1 }, { name: 'N' }])
  })
})

describe(parseDebug, () => {
  it('maps an empty list and "true" to every bb category and splits lists into enabled and silenced', () => {
    const everything = { enabled: [['bb']], silenced: [] }
    expect(['', 'true'].map((flag) => parseDebug(flag))).toStrictEqual([everything, everything])
    expect(parseDebug(' bb.agent , !bb.store,,')).toStrictEqual({
      enabled: [['bb', 'agent']],
      silenced: [['bb', 'store']],
    })
  })
})
