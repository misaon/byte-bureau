import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const OWNER_ONLY_DIRECTORY = 0o700
const OWNER_ONLY_FILE = 0o600

// The one call that changes a mode; a test passes one that the system refuses
export type Chmod = (file: string, mode: number) => void

export interface PreparedHome {
  readonly data: string
  // What could not be made private, for the log once it is configured: the start goes on
  readonly warnings: readonly string[]
}

const codeOf = (error: unknown): unknown =>
  error instanceof Error && 'code' in error ? error.code : undefined

// A file that is not there has nothing to narrow, and a mode the system refuses to set is a warning, never a failed start
function narrow(file: string, mode: number, chmod: Chmod): readonly string[] {
  try {
    chmod(file, mode)
    return []
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return codeOf(error) === 'ENOENT'
      ? []
      : [`${file} could not be made private to its user: ${reason}`]
  }
}

// The directory when this call created it; mkdir creates it, and any missing parent, for the user alone
const created = (directory: string): readonly string[] =>
  mkdirSync(directory, { recursive: true, mode: OWNER_ONLY_DIRECTORY }) === undefined
    ? []
    : [directory]

// The home and its data directory are created for the user alone, whatever the umask
// One that exists keeps its mode: BYTEBUREAU_HOME may name a directory the user shares on purpose
export function prepareHome(home: string, chmod: Chmod = chmodSync): PreparedHome {
  const data = path.join(home, 'data')
  const directories = [...created(home), ...created(data)]
  return {
    data,
    warnings: directories.flatMap((directory) => narrow(directory, OWNER_ONLY_DIRECTORY, chmod)),
  }
}

// SQLite creates the database, its WAL and its shared memory with the umask; once they are open they are narrowed to the user
export const restrictDatabase = (database: string, chmod: Chmod = chmodSync): readonly string[] =>
  [database, `${database}-wal`, `${database}-shm`].flatMap((file) =>
    narrow(file, OWNER_ONLY_FILE, chmod),
  )
