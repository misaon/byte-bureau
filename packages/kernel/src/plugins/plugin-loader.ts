import type { KernelEvent, Plugin, PluginRegistration } from '@bytebureau/plugin-api'
import { Effect, Result } from 'effect'
import { constVoid } from 'effect/Function'
import { PluginError } from '../errors.js'
import { kernelLogger } from '../logging/logging.js'
import { HookBus } from './hooks.js'
import type { ContextDeps } from './plugin-context.js'
import { setUpPlugin } from './plugin-setup.js'
import { PortRegistry, portsOf } from './port-registry.js'
import { reasonOf } from './reason.js'

export interface PluginStatus {
  readonly name: string
  readonly version: string
  readonly state: 'loaded' | 'failed'
  readonly reason?: string | undefined
  readonly ports: readonly string[]
}

interface Loaded {
  readonly name: string
  readonly registration: PluginRegistration
}

// Sets plugins up one after the other, records what each did and registers what the loaded ones offer
export class PluginLoader {
  public readonly hooks = new HookBus(['bb', 'plugin'])
  public readonly ports = new PortRegistry()
  private readonly statuses: PluginStatus[] = []
  private readonly loaded: Loaded[] = []
  private readonly logger = kernelLogger(['bb', 'plugin'])
  private readonly deps: ContextDeps
  private readonly configs: Readonly<Record<string, unknown>>

  public constructor(deps: ContextDeps, configs: Readonly<Record<string, unknown>>) {
    this.deps = deps
    this.configs = configs
  }

  public plugins(): readonly PluginStatus[] {
    return [...this.statuses]
  }

  // A plugin that is refused is recorded and announced, and never stops the others
  public load(plugins: readonly Plugin[]): Effect.Effect<void> {
    return Effect.forEach(plugins, (plugin) => this.loadOne(plugin), { discard: true })
  }

  // The plugins that loaded go in reverse order, and a plugin that fails to dispose does not keep the others
  public dispose(): Effect.Effect<void> {
    return Effect.forEach(
      this.loaded.toReversed(),
      ({ name, registration }) => this.release(name, registration),
      { discard: true },
    )
  }

  private loadOne(plugin: Plugin): Effect.Effect<void> {
    return Effect.result(this.admit(plugin)).pipe(
      Effect.flatMap((outcome) =>
        Result.isFailure(outcome)
          ? this.refuse(plugin, outcome.failure)
          : this.accept(plugin, outcome.success),
      ),
    )
  }

  private admit(plugin: Plugin): Effect.Effect<PluginRegistration, PluginError> {
    const { name } = plugin.manifest
    if (this.loaded.some((entry) => entry.name === name)) {
      const reason = `a plugin named ${name} is already loaded`
      return Effect.fail(new PluginError({ plugin: name, reason }))
    }
    return this.setUp(plugin).pipe(
      Effect.flatMap((registration) => this.register(plugin, registration)),
    )
  }

  private setUp(plugin: Plugin): Effect.Effect<PluginRegistration, PluginError> {
    const { name } = plugin.manifest
    return Effect.tryPromise({
      try: async () => {
        const registration = await setUpPlugin(plugin, this.configs[name], this.deps)
        return registration
      },
      catch: (failure) => new PluginError({ plugin: name, reason: reasonOf(failure) }),
    })
  }

  // A port another plugin holds refuses the plugin, which is disposed at once; its hooks never reach the bus
  private register(
    plugin: Plugin,
    registration: PluginRegistration,
  ): Effect.Effect<PluginRegistration, PluginError> {
    const { name } = plugin.manifest
    const held = this.ports.claim(name, registration)
    if (held !== undefined) {
      const refusal = Effect.fail(new PluginError({ plugin: name, reason: held }))
      return Effect.andThen(this.release(name, registration), refusal)
    }
    this.hooks.registerAll(name, registration.hooks ?? {})
    this.loaded.push({ name, registration })
    return Effect.succeed(registration)
  }

  private accept(plugin: Plugin, registration: PluginRegistration): Effect.Effect<void> {
    const { name, version } = plugin.manifest
    const ports = portsOf(registration)
    this.statuses.push({ name, version, state: 'loaded', ports })
    return this.announce({ type: 'plugin.loaded', payload: { name, version, ports } })
  }

  private refuse(plugin: Plugin, failure: PluginError): Effect.Effect<void> {
    const { name, version } = plugin.manifest
    const { reason } = failure
    this.statuses.push({ name, version, state: 'failed', reason, ports: [] })
    this.logger.warn('plugin failed', { plugin: name, reason })
    return this.announce({ type: 'plugin.failed', payload: { name, reason } })
  }

  // The log failing to record an announcement does not undo the plugin's outcome
  private announce(event: KernelEvent): Effect.Effect<void> {
    return Effect.match(this.deps.log.publish(event), {
      onFailure: (failure) => {
        this.logger.warn('plugin event not recorded', {
          type: event.type,
          reason: reasonOf(failure.cause),
        })
      },
      onSuccess: constVoid,
    })
  }

  private release(name: string, registration: PluginRegistration): Effect.Effect<void> {
    const disposing = Effect.tryPromise({
      try: async () => {
        if (registration.dispose !== undefined) {
          await registration.dispose()
        }
      },
      catch: (failure) => failure,
    })
    return Effect.match(disposing, {
      onFailure: (failure) => {
        this.logger.warn('plugin dispose failed', { plugin: name, reason: reasonOf(failure) })
      },
      onSuccess: constVoid,
    })
  }
}
