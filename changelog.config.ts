import type { ChangelogConfig } from 'changelogen'

const config: Partial<ChangelogConfig> = {
  repo: { repo: 'misaon/byte-bureau', provider: 'github', domain: 'github.com' },
  output: 'CHANGELOG.md',
  scopeMap: { bytebureau: 'cli' },
}

export default config
