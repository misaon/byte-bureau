import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { writePrivateFile } from './private-file.js'

const TOKEN = /^[0-9a-f]{64}$/u

export const tokenPath = (home: string): string => path.join(home, 'daemon.token')

export const freshToken = (): string => randomBytes(32).toString('hex')

// The token an earlier start of the home kept, if its file holds one
const keptToken = (home: string): string | undefined => {
  try {
    const kept = readFileSync(tokenPath(home), 'utf8').trim()
    return TOKEN.test(kept) ? kept : undefined
  } catch {
    return undefined
  }
}

// Generated at the first start of the home and kept for every later one, so a client that read it keeps working across a restart
// The file outlives server.json, which carries a copy only while a daemon runs
export const tokenFor = (home: string): string => {
  const kept = keptToken(home)
  if (kept !== undefined) {
    return kept
  }
  const token = freshToken()
  writePrivateFile(tokenPath(home), `${token}\n`)
  return token
}
