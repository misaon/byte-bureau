import { homedir } from 'node:os'
import path from 'node:path'

// An empty BYTEBUREAU_HOME names no directory: taken as it is it would put the data in ./data
// A relative one is resolved against the working directory once, so the kernel never depends on where it later runs
export function kernelHome(env: Readonly<Record<string, string | undefined>>): string {
  const home = env['BYTEBUREAU_HOME']
  return home === undefined || home === ''
    ? path.join(homedir(), '.bytebureau')
    : path.resolve(home)
}
