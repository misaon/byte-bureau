import { homedir } from 'node:os'
import path from 'node:path'

// An empty BYTEBUREAU_HOME names no directory: taken as it is it would put the data in ./data
export function kernelHome(env: Readonly<Record<string, string | undefined>>): string {
  const home = env['BYTEBUREAU_HOME']
  return home === undefined || home === '' ? path.join(homedir(), '.bytebureau') : home
}
