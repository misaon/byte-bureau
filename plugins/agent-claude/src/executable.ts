import { existsSync } from 'node:fs'
import path from 'node:path'

const WINDOWS_SUFFIXES = ['', '.exe', '.cmd']

// A path is taken as it is when it exists; a bare name is looked up on PATH; undefined when it is nowhere
export const resolveExecutable = (
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined => {
  if (name.includes('/') || name.includes(path.sep)) {
    const resolved = path.resolve(name)
    return existsSync(resolved) ? resolved : undefined
  }
  const suffixes = platform === 'win32' ? WINDOWS_SUFFIXES : ['']
  const directories = (env['PATH'] ?? '').split(path.delimiter).filter((entry) => entry !== '')
  const candidates = directories.flatMap((directory) =>
    suffixes.map((suffix) => path.join(directory, `${name}${suffix}`)),
  )
  return candidates.find((candidate) => existsSync(candidate))
}
