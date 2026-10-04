import { Config, kernelLogger, nowIso, PluginHost, SessionManager } from '@bytebureau/kernel'
import { kernelBunLayer, type KernelOptions } from '@bytebureau/kernel/bun'
import { BunHttpServer } from '@effect/platform-bun'
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect'
import { HttpServer } from 'effect/http'
import { boundAddress, type BoundAddress } from './bun-address.js'
import { DEFAULT_API_OPTIONS } from './config.js'
import { DefectReporter, portInUse } from './daemon-errors.js'
import { serveApi } from './layer.js'

export { PortInUseError } from './daemon-errors.js'
export type { BoundAddress } from './bun-address.js'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 4747
const MAX_BODY_BYTES = 10 * 1024 * 1024

type ServeOptions = Parameters<typeof BunHttpServer.layer>[0]
type ServerLayer = ReturnType<typeof BunHttpServer.layer>
type KernelLayer = Awaited<ReturnType<typeof kernelBunLayer>>
type DaemonRuntime = ManagedRuntime.ManagedRuntime<
  PluginHost | SessionManager | HttpServer.HttpServer,
  unknown
>

// Bun's own knobs: the hostname must be passed, as Bun binds every interface otherwise; its 10 s idle timeout would cut an SSE stream
// Bun's body limit holds where Effect's does not; at 10 MiB it sits above the API's 10 MB check, which answers a declared length first
// Open streams must not delay a shutdown by the 20 s default
// A WebSocket client that stops reading is closed instead of buffered without bound, and its frames are capped like a body
const serveOptions = ({ host, port }: BoundAddress): ServeOptions => ({
  hostname: host,
  port,
  idleTimeout: 60,
  maxRequestBodySize: MAX_BODY_BYTES,
  gracefulShutdownTimeout: '2 seconds',
  websocket: {
    closeOnBackpressureLimit: true,
    backpressureLimit: 1024 * 1024,
    maxPayloadLength: MAX_BODY_BYTES,
  },
})

export interface DaemonOptions extends KernelOptions {
  readonly version: string
  // Plain text here, as the CLI that passes it imports no Effect; it is wrapped in Redacted at once
  readonly token: string
  // Flags win; what they leave out comes from the user configuration, then the defaults
  readonly host?: string | undefined
  readonly port?: number | undefined
  readonly corsOrigins?: readonly string[] | undefined
}

export interface RunningDaemon {
  readonly address: BoundAddress
  readonly startedAt: string
  // Stops the server, the agents and the store
  readonly close: () => Promise<void>
}

interface ServerSection {
  readonly host?: string | undefined
  readonly port?: number | undefined
}

// The port the start asked for, known once the configuration has been read inside the runtime: a refusal names it
interface Requested {
  port: number
}

const logger = kernelLogger(['bb', 'api'])

const formattedAddress = HttpServer.addressFormattedWith((address) => Effect.succeed(address))

// The kernel is given what it reads, and never the token
const kernelOptionsOf = ({
  home,
  env,
  logging,
  extraPlugins,
  pluginConfig,
}: DaemonOptions): KernelOptions => ({ home, env, logging, extraPlugins, pluginConfig })

// The server section of the user configuration; one that cannot be read leaves the address to the flags and the defaults, and says so
const configuredServer = (env: KernelOptions['env']): Effect.Effect<ServerSection, never, Config> =>
  Config.use((config) => config.load({ env })).pipe(
    Effect.map((resolved): ServerSection => resolved.user.server ?? {}),
    Effect.catchTag('ConfigError', (failure) =>
      Effect.sync((): ServerSection => {
        logger.warn('the user configuration cannot be read: its server section is not applied', {
          file: failure.file,
          reason: failure.reason,
        })
        return {}
      }),
    ),
  )

// The Bun server on the address of the flags, else of the user configuration (read through the kernel's Config of this runtime), else the defaults
const resolveServer = (
  options: DaemonOptions,
  requested: Requested,
): Layer.Layer<Layer.Success<ServerLayer>, Layer.Error<ServerLayer>, Config> =>
  Layer.unwrap(
    Effect.map(configuredServer(options.env), (configured) => {
      const address = {
        host: options.host ?? configured.host ?? DEFAULT_HOST,
        port: options.port ?? configured.port ?? DEFAULT_PORT,
      }
      requested.port = address.port
      return BunHttpServer.layer(serveOptions(address))
    }),
  )

// The API of this start; a defect behind either of its doors is logged under bb.api
const apiOf = (options: DaemonOptions, startedAt: string): ReturnType<typeof serveApi> => {
  const reporter = DefectReporter((message, properties) => {
    logger.error(message, properties)
  })
  return serveApi({
    ...DEFAULT_API_OPTIONS,
    version: options.version,
    startedAt,
    token: Redacted.make(options.token),
    corsOrigins: options.corsOrigins ?? DEFAULT_API_OPTIONS.corsOrigins,
  }).pipe(Layer.provide(reporter))
}

interface Built {
  readonly runtime: DaemonRuntime
  readonly requested: Requested
}

// The kernel, the API and the Bun server as one runtime
const buildRuntime = (options: DaemonOptions, kernel: KernelLayer, startedAt: string): Built => {
  const requested: Requested = { port: options.port ?? DEFAULT_PORT }
  const layer = apiOf(options, startedAt).pipe(
    Layer.provideMerge(resolveServer(options, requested)),
    Layer.provideMerge(kernel),
  )
  return { runtime: ManagedRuntime.make(layer), requested }
}

// The plugins load and the sessions a previous process left at work are recovered before the address is given out
async function boot(runtime: DaemonRuntime): Promise<BoundAddress> {
  await runtime.runPromise(PluginHost.use((host) => host.load()))
  const recovered = await runtime.runPromise(SessionManager.use((sessions) => sessions.recover()))
  if (recovered.length > 0) {
    logger.info('recovered sessions left by a previous process', { sessions: recovered })
  }
  return boundAddress(await runtime.runPromise(formattedAddress))
}

/**
 * Starts the kernel with the API on Bun and resolves once the daemon serves: its plugins loaded, the sessions of a previous process recovered, the address bound (port 0 becomes a free one).
 * A start that fails is disposed before the failure is passed on; a taken port fails with PortInUseError.
 */
export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const kernel = await kernelBunLayer(kernelOptionsOf(options))
  const startedAt = nowIso()
  const { runtime, requested } = buildRuntime(options, kernel, startedAt)
  try {
    const address = await boot(runtime)
    return {
      address,
      startedAt,
      close: async () => {
        await runtime.dispose()
      },
    }
  } catch (error) {
    await Promise.allSettled([runtime.dispose()])
    throw portInUse(error, requested.port) ?? error
  }
}
