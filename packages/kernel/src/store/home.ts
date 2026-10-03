import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const OWNER_ONLY_DIRECTORY = 0o700
const OWNER_ONLY_FILE = 0o600

// The home of the kernel is created for its user alone, and its data directory is narrowed to the user whenever the kernel starts
// An existing home keeps its mode: BYTEBUREAU_HOME may name a directory the user shares on purpose
export function prepareHome(home: string): string {
  const data = path.join(home, 'data')
  mkdirSync(home, { recursive: true, mode: OWNER_ONLY_DIRECTORY })
  mkdirSync(data, { recursive: true, mode: OWNER_ONLY_DIRECTORY })
  chmodSync(data, OWNER_ONLY_DIRECTORY)
  return data
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'

// SQLite creates the database, its WAL and its shared memory with the umask; once they are open they are narrowed to the user
export function restrictDatabase(database: string): void {
  for (const file of [database, `${database}-wal`, `${database}-shm`]) {
    try {
      chmodSync(file, OWNER_ONLY_FILE)
    } catch (error) {
      if (!isMissing(error)) {
        throw error
      }
    }
  }
}
