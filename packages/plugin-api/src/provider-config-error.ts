// A provider section the adapter cannot use, such as an unknown key or a missing command
// The kernel tells it as a configuration error of the project, never as a crash of an agent that never ran
export class ProviderConfigError extends Error {
  public readonly reason: string

  public constructor(reason: string) {
    super(reason)
    this.name = 'ProviderConfigError'
    this.reason = reason
  }
}
