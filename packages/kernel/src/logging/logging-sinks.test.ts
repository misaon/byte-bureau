import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { LogRecord } from '@logtape/logtape'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { captured, written } from './logging-fixtures.js'
import { configureLogging, kernelLogger, resetLogging } from './logging.js'

const logger = kernelLogger(['bb', 'sinks'])

// A file sink in a directory of its own, read back once the logging is done
async function fileOutput(log: () => void): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-logging-'))
  const file = path.join(dir, 'kernel.log')
  try {
    await captured({ level: 'info', json: true, file }, Effect.sync(log))
    return readFileSync(file, 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// What the console sink writes while the logging runs
async function consoleOutput(log: () => void): Promise<readonly string[]> {
  const output = await written(async () => {
    await captured({ level: 'trace', json: true }, Effect.sync(log))
  })
  expect(output.stdout).toStrictEqual([])
  return output.stderr
}

const lineOf = (output: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(output.trim())
  return typeof parsed === 'object' && parsed !== null ? { ...parsed } : {}
}

const logSecrets = (): void => {
  logger.info('key sk-ant-api03-canary', { apiKey: 'field-only-value', keep: 1 })
}

// A sink that throws once, the records it was given before LogTape reset it, and what went to stderr
async function failingSinkRun(): Promise<{
  readonly delivered: readonly unknown[]
  readonly stderr: readonly string[]
}> {
  const capture = vi.fn<(record: LogRecord) => void>().mockImplementationOnce(() => {
    throw new Error('sink boom')
  })
  // Disposing the sinks at reset restores the mock, so its calls are read before
  let delivered: readonly unknown[] = []
  const output = await written(async () => {
    await configureLogging({ level: 'info', json: true, capture })
    logger.info('first')
    logger.info('second')
    delivered = capture.mock.calls.map(([entry]) => entry.message[0])
    await resetLogging()
  })
  return { delivered, stderr: output.stderr }
}

describe('the console sink', () => {
  it('writes every record to stderr, whatever its level, and nothing to stdout', async () => {
    expect.hasAssertions()
    const stderr = await consoleOutput(() => {
      logger.debug('debug line')
      logger.info('info line')
      logger.warn('warn line')
      logger.error('error line')
    })
    expect(stderr.map((line) => lineOf(line)['message'])).toStrictEqual([
      'debug line',
      'info line',
      'warn line',
      'error line',
    ])
  })

  it('reports a throwing sink on stderr and keeps delivering to it', async () => {
    expect.hasAssertions()
    const { delivered, stderr } = await failingSinkRun()
    expect(delivered).toStrictEqual(['first', 'second'])
    const reports = stderr
      .map((line) => lineOf(line))
      .filter((line) => line['logger'] === 'logtape.meta')
    expect(reports).toMatchObject([
      { level: 'FATAL', properties: { error: { message: 'sink boom' } } },
    ])
  })

  it('redacts secrets in the console and file output', async () => {
    expect.hasAssertions()
    const outputs = [await fileOutput(logSecrets), ...(await consoleOutput(logSecrets))]
    expect(outputs).toHaveLength(2)
    for (const output of outputs) {
      expect(output).toContain('"keep":1')
      expect(output).toContain('[REDACTED]')
      expect(output).not.toContain('canary')
      expect(output).not.toContain('field-only-value')
    }
  })
})

// An object that holds itself, one fifteen levels deep and one with three hundred properties
function shapes(): Record<string, unknown> {
  const cyclic: Record<string, unknown> = { name: 'loop' }
  cyclic['self'] = cyclic
  let deep: Record<string, unknown> = { leaf: 'deep-canary' }
  for (let level = 0; level < 15; level += 1) {
    deep = { inner: deep }
  }
  const keys = [...Array.from({ length: 300 }).keys()]
  const wide = Object.fromEntries(keys.map((key) => [`k${key}`, key]))
  return { cyclic, deep, wide }
}

describe('the properties of a record on their way to a sink', () => {
  it('turns a bigint into text, so the JSON formatter keeps the record', async () => {
    expect.hasAssertions()
    const output = await fileOutput(() => {
      logger.info('counted', { total: 10n, nested: { size: 2n } })
    })
    expect(lineOf(output)).toMatchObject({
      message: 'counted',
      properties: { total: '10', nested: { size: '2' } },
    })
  })

  it('puts the own fields and the cause of an Error through the field redaction', async () => {
    expect.hasAssertions()
    const inner = Object.assign(new Error('inner'), { token: 'canary-inner' })
    const error = Object.assign(new Error('boom', { cause: inner }), {
      password: 'canary-outer',
      status: 500,
    })
    const seen = await captured(
      { level: 'info', json: true },
      Effect.sync(() => {
        logger.error('failed', { error })
      }),
    )
    expect(JSON.stringify(seen.map((entry) => entry.properties))).not.toContain('canary')
    expect(seen.map((entry) => entry.properties)).toMatchObject([
      { error: { name: 'Error', message: 'boom', status: 500, cause: { message: 'inner' } } },
    ])
  })

  it('cuts a cycle and bounds how deep and how wide the redaction goes', async () => {
    expect.hasAssertions()
    const stderr = await consoleOutput(() => {
      logger.info('shapes', shapes())
    })
    const record = String(stderr.find((line) => line.includes('"shapes"')))
    expect(lineOf(record)).toMatchObject({ properties: { cyclic: { self: '[Circular]' } } })
    expect(record).not.toContain('deep-canary')
    expect(record).toContain('"k199":199')
    expect(record).not.toContain('"k250"')
  })
})
