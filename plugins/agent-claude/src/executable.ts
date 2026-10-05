import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'

const WINDOWS_SUFFIXES = ['', '.exe', '.cmd']

// A file this process may run: a directory, or a file without the execute bit, is no claude
const isExecutableFile = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

// A path is taken as it is when it is a file to run; a bare name is looked up in the absolute directories of PATH alone, so the directory the daemon runs in never lends one; undefined when it is nowhere
export const resolveExecutable = (
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined => {
  if (name.includes('/') || name.includes(path.sep)) {
    const resolved = path.resolve(name)
    return isExecutableFile(resolved) ? resolved : undefined
  }
  const suffixes = platform === 'win32' ? WINDOWS_SUFFIXES : ['']
  const directories = (env['PATH'] ?? '')
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry))
  const candidates = directories.flatMap((directory) =>
    suffixes.map((suffix) => path.join(directory, `${name}${suffix}`)),
  )
  return candidates.find((candidate) => isExecutableFile(candidate))
}
