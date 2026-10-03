import type { ProjectConfig } from '@bytebureau/protocol'
import { Effect } from 'effect'
import { Config, ConfigLive } from '../config/config.js'
import { configureLogging, parseLogLevel, type KernelLogLevel } from '../logging/logging.js'
import type { KernelOptions } from './types.js'

const levelOf = ({ logging }: ProjectConfig): KernelLogLevel =>
  logging === undefined || logging.level === undefined ? 'info' : logging.level

// The level a kernel logs at: the flag when one is given, else the user file and BYTEBUREAU_LOG_LEVEL, else info
// A configuration that cannot be read does not stop the kernel: the commands that read it report the problem
export async function bootLevel(options: KernelOptions): Promise<KernelLogLevel> {
  const { level } = options.logging ?? {}
  if (level !== undefined) {
    return parseLogLevel(level)
  }
  const configured = Config.use((config) => config.load({ env: options.env })).pipe(
    Effect.match({
      onFailure: (): KernelLogLevel => 'info',
      onSuccess: (resolved) => levelOf(resolved.project),
    }),
    Effect.provide(ConfigLive(options.home)),
  )
  const resolved = await Effect.runPromise(configured)
  return resolved
}

// Records go to stderr, so their format follows stderr: pretty at a terminal, JSON lines otherwise
export async function configureKernelLogging(options: KernelOptions): Promise<void> {
  const { json, debug } = options.logging ?? {}
  await configureLogging({
    level: await bootLevel(options),
    json: json ?? !process.stderr.isTTY,
    debug,
  })
}
