import type { Hook, Hooks } from '@bytebureau/plugin-api'
import type { Effect } from 'effect'
import { kernelLogger } from '../logging/logging.js'
import { HookChain } from './hooks-chain.js'

type HookName = keyof Hooks
type Input<Name extends HookName> = Parameters<Hooks[Name]>[0]
type Result<Name extends HookName> = Awaited<ReturnType<Hooks[Name]>>

// The hook of a name, typed by the name so that a hook cannot be registered under another
type Registered = { [Name in HookName]: Hook<Input<Name>, Result<Name>> }
type Chains = { [Name in HookName]: HookChain<Input<Name>, Result<Name>> }

// Middleware chains in registration order; a throwing hook is logged and skipped
export class HookBus {
  private readonly chains: Chains

  public constructor(category: readonly string[]) {
    const logger = kernelLogger([...category, 'hooks'])
    this.chains = {
      'session.beforeCreate': new HookChain(logger, 'session.beforeCreate'),
      'agent.beforeSpawn': new HookChain(logger, 'agent.beforeSpawn'),
      'ask.beforeOpen': new HookChain(logger, 'ask.beforeOpen'),
      'prompt.beforeSend': new HookChain(logger, 'prompt.beforeSend'),
      'event.beforePublish': new HookChain(logger, 'event.beforePublish'),
    }
  }

  public register<Name extends HookName>(plugin: string, name: Name, hook: Registered[Name]): void {
    this.chains[name].add(plugin, hook)
  }

  // Whatever hooks a plugin has, each under its own name
  public registerAll(plugin: string, hooks: Partial<Hooks>): void {
    this.offer(plugin, 'session.beforeCreate', hooks['session.beforeCreate'])
    this.offer(plugin, 'agent.beforeSpawn', hooks['agent.beforeSpawn'])
    this.offer(plugin, 'ask.beforeOpen', hooks['ask.beforeOpen'])
    this.offer(plugin, 'prompt.beforeSend', hooks['prompt.beforeSend'])
    this.offer(plugin, 'event.beforePublish', hooks['event.beforePublish'])
  }

  public run<Name extends HookName>(
    name: Name,
    input: Input<Name>,
    terminal: (input: Input<Name>) => Effect.Effect<Result<Name>>,
  ): Effect.Effect<Result<Name>> {
    return this.chains[name].run(input, terminal)
  }

  private offer<Name extends HookName>(
    plugin: string,
    name: Name,
    hook: Registered[Name] | undefined,
  ): void {
    if (hook !== undefined) {
      this.register(plugin, name, hook)
    }
  }
}
