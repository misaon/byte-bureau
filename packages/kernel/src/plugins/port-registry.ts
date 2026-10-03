import type { AgentProvider, PluginRegistration, WorkspaceRuntime } from '@bytebureau/plugin-api'

// The ports that have an id of their own, and so can be taken
const identified = (registration: PluginRegistration): readonly string[] => [
  ...(registration.agentProviders ?? []).map((provider) => `agentProviders:${provider.id}`),
  ...(registration.workspaceRuntimes ?? []).map((runtime) => `workspaceRuntimes:${runtime.id}`),
]

// Every port a registration offers, as plugin.loaded reports them
export const portsOf = (registration: PluginRegistration): readonly string[] => [
  ...identified(registration),
  ...(registration.secretStores ?? []).map(() => 'secretStores'),
]

// The ports of the plugins that loaded; the first plugin to offer a port keeps it
export class PortRegistry {
  private readonly providers = new Map<string, AgentProvider>()
  private readonly runtimes = new Map<string, WorkspaceRuntime>()
  private readonly owners = new Map<string, string>()

  // Takes all ports of a registration, or none and returns which port is held already, and by whom
  public claim(plugin: string, registration: PluginRegistration): string | undefined {
    const [held] = this.heldPorts(registration)
    if (held === undefined) {
      this.store(plugin, registration)
    }
    return held
  }

  public agentProviders(): readonly AgentProvider[] {
    return [...this.providers.values()]
  }

  public agentProvider(id: string): AgentProvider | undefined {
    return this.providers.get(id)
  }

  public workspaceRuntimes(): readonly WorkspaceRuntime[] {
    return [...this.runtimes.values()]
  }

  public workspaceRuntime(id: string): WorkspaceRuntime | undefined {
    return this.runtimes.get(id)
  }

  private heldPorts(registration: PluginRegistration): readonly string[] {
    return identified(registration).flatMap((port) => {
      const owner = this.owners.get(port)
      return owner === undefined ? [] : [`${port} is already provided by plugin ${owner}`]
    })
  }

  private store(plugin: string, registration: PluginRegistration): void {
    for (const port of identified(registration)) {
      this.owners.set(port, plugin)
    }
    for (const provider of registration.agentProviders ?? []) {
      this.providers.set(provider.id, provider)
    }
    for (const runtime of registration.workspaceRuntimes ?? []) {
      this.runtimes.set(runtime.id, runtime)
    }
  }
}
