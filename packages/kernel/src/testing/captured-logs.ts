import type { LogRecord } from '@logtape/logtape'
import { onTestFinished, vi } from 'vitest'
import { configureLogging, resetLogging } from '../logging/logging.js'

// The level and the text of each record a category of the kernel logged
export const linesOf = (
  records: readonly LogRecord[],
  category: string,
): readonly (readonly [string, string])[] =>
  records
    .filter((record) => record.category.join('.') === category)
    .map((record) => [record.level, String(record.message[0])] as const)

// What the kernel logs from debug up while the test runs, kept off stderr; LogTape is reset when the test ends
export async function capturedLogs(): Promise<readonly LogRecord[]> {
  const records: LogRecord[] = []
  const quiet = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  await configureLogging({
    level: 'debug',
    json: true,
    capture: (record) => {
      records.push(record)
    },
  })
  onTestFinished(async () => {
    await resetLogging()
    quiet.mockRestore()
  })
  return records
}
