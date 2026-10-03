import { writeFileSync } from 'node:fs'
import path from 'node:path'

// The project file of a fixture repository, as given
export function writeConfig(repo: string, config: Record<string, unknown>): void {
  writeFileSync(path.join(repo, 'bytebureau.json'), JSON.stringify(config))
}
