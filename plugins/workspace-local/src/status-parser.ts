export interface ParsedStatus {
  readonly dirty: boolean
  readonly ahead: number
  readonly behind: number
  readonly branch: string
}

const BRANCH_HEAD = '# branch.head '
const AHEAD_BEHIND = /^# branch\.ab \+(?<ahead>\d+) -(?<behind>\d+)$/u

function readHeader(line: string, status: { ahead: number; behind: number; branch: string }): void {
  if (line.startsWith(BRANCH_HEAD)) {
    status.branch = line.slice(BRANCH_HEAD.length)
    return
  }
  const match = AHEAD_BEHIND.exec(line)
  if (match !== null && match.groups !== undefined) {
    status.ahead = Number(match.groups['ahead'])
    status.behind = Number(match.groups['behind'])
  }
}

// Output of `git status --porcelain=v2 --branch`: `#` headers, then one entry per change
export function parseStatusV2(text: string): ParsedStatus {
  const status = { dirty: false, ahead: 0, behind: 0, branch: '' }
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) {
      readHeader(line, status)
    } else if (line.trim() !== '') {
      status.dirty = true
    }
  }
  return status
}
