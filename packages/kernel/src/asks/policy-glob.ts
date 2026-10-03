import path from 'node:path'
import type { Place } from './policy-command.js'

const { posix } = path

// A glob stands for one pattern per alternative of its braces; past this many it is not judged at all
const MOST_PATTERNS = 64
const DEPTH: ReadonlyMap<string, number> = new Map([
  ['{', 1],
  ['}', -1],
])
// A glob library reads \. as a dot and \/ as a slash
const ESCAPE = /\\(?<char>.)/gsu

interface Group {
  readonly start: number
  readonly end: number
  readonly commas: readonly number[]
}

// The braces that open at start, with the commas at their own depth; undefined when they never close
function groupAt(glob: string, start: number): Group | undefined {
  let depth = 0
  const commas: number[] = []
  for (let index = start; index < glob.length; index += 1) {
    const char = glob.charAt(index)
    depth += DEPTH.get(char) ?? 0
    if (depth === 0) {
      return { start, end: index, commas }
    }
    if (char === ',' && depth === 1) {
      commas.push(index)
    }
  }
  return undefined
}

// The first braces that hold a comma; braces without one stay as they are
function firstGroup(glob: string): Group | undefined {
  for (const brace of glob.matchAll(/\{/gu)) {
    const group = groupAt(glob, brace.index)
    if (group !== undefined && group.commas.length > 0) {
      return group
    }
  }
  return undefined
}

// The pattern once for each alternative of the group, the braces gone
function alternativesOf(glob: string, group: Group): readonly string[] {
  const head = glob.slice(0, group.start)
  const tail = glob.slice(group.end + 1)
  const bounds = [group.start, ...group.commas, group.end]
  return bounds
    .slice(1)
    .map((bound, index) => `${head}${glob.slice((bounds[index] ?? group.start) + 1, bound)}${tail}`)
}

// A pattern without braces is done; one with braces gives way to the patterns of its first group
function expandNext(done: string[], pending: string[]): void {
  const pattern = pending.pop() ?? ''
  const group = firstGroup(pattern)
  if (group === undefined) {
    done.push(pattern)
  } else {
    pending.push(...alternativesOf(pattern, group))
  }
}

// Every pattern the braces of a glob stand for, nested ones too; undefined when there are more than MOST_PATTERNS
function patternsOf(glob: string): readonly string[] | undefined {
  const done: string[] = []
  const pending = [glob]
  while (pending.length > 0) {
    if (done.length + pending.length > MOST_PATTERNS) {
      return undefined
    }
    expandNext(done, pending)
  }
  return done
}

// Where a glob reaches: one place for each pattern its braces stand for, escapes dropped, below its base or where an absolute pattern points
// Only the literal part of a pattern can lead anywhere, so a pattern with a .. segment, which climbs out of any directory, leads nowhere that can be judged
export function globPlaces(
  glob: string,
  base: string,
  resolve: (written: string) => string,
): readonly Place[] {
  const patterns = patternsOf(glob)
  if (patterns === undefined) {
    return [{ word: glob, resolved: null }]
  }
  return patterns
    .map((pattern) => pattern.replaceAll(ESCAPE, '$<char>'))
    .map((pattern) => {
      const word = posix.isAbsolute(pattern) ? pattern : posix.join(base, pattern)
      return { word, resolved: pattern.split('/').includes('..') ? null : resolve(word) }
    })
}
