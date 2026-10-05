// The adapter's own refusal of an agent that has not died: one that speaks another version of ACP, or does not start in time
export class RefusedAgentError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'RefusedAgentError'
  }
}
