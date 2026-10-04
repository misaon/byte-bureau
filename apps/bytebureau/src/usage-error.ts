// A usage mistake, told as citty tells its own: the usage of the command, then the message, and exit code 1
export const usageError = (message: string): Error =>
  Object.assign(new Error(message), { name: 'CLIError' })
