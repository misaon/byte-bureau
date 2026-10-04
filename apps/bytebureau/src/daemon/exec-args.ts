export interface ProcessLike {
  readonly execPath: string
  readonly argv: readonly string[]
}

export interface ExecArgs {
  readonly command: string
  readonly args: readonly string[]
}

// The daemon is this very program run again in the foreground: the compiled binary, or bun with the source entry
// A compiled binary names a virtual path where the entry would be, which is no source file
export const daemonExecArgs = (current: ProcessLike, extra: readonly string[]): ExecArgs => {
  const [, entry] = current.argv
  const fromSource = entry !== undefined && /\.[cm]?[jt]s$/u.test(entry)
  return fromSource
    ? { command: current.execPath, args: ['run', entry, 'serve', '--no-daemonize', ...extra] }
    : { command: current.execPath, args: ['serve', '--no-daemonize', ...extra] }
}
