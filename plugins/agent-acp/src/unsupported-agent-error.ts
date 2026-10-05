// The adapter's own refusal of an agent that answered, such as one that speaks another version of ACP
export class UnsupportedAgentError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'UnsupportedAgentError'
  }
}
