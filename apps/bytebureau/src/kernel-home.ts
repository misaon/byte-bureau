import { homedir } from 'node:os'
import path from 'node:path'
import { m } from '@bytebureau/i18n'

// An empty BYTEBUREAU_HOME is most often a variable that expanded to nothing: refused, never taken for ~/.bytebureau
// A relative one is resolved against the working directory once, so the kernel never depends on where it later runs
export function kernelHome(env: Readonly<Record<string, string | undefined>>): string {
  const home = env['BYTEBUREAU_HOME']
  if (home === undefined) {
    return path.join(homedir(), '.bytebureau')
  }
  if (home.trim() === '') {
    throw new Error(m.cli_home_empty())
  }
  return path.resolve(home)
}
