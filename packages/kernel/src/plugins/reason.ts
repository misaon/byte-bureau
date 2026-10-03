// The text a failure is reported with, whatever was thrown
export const reasonOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)
