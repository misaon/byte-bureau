/**
 * A provider section the adapter cannot use, such as an unknown key or a missing command.
 * The kernel tells it as a configuration error of the project, never as a crash of an agent that never ran.
 */
export class ProviderConfigError extends Error {
  public readonly reason: string

  /** @param reason What is wrong with the section, naming its key, as a person reads it. */
  public constructor(reason: string) {
    super(reason)
    this.name = 'ProviderConfigError'
    this.reason = reason
  }
}
