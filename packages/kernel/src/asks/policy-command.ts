// CSpell:ignore cdfmtu
import path from 'node:path'

const { posix } = path

// A listed command named in full: its word ends at a space or at the end of the command; find is not listed, its -delete and -exec remove and run
const READ_ONLY =
  /^(?:git (?:status|log|diff|show|branch|rev-parse)|ls|cat|head|tail|rg|grep|wc|pwd|echo)(?:[ \t]|$)/u
// What makes a command more than one simple command, or more than a read: a pipe, a list, a background job, a redirection, a substitution (parentheses cover $(), <() and zsh =()) or a line break
const SHELL_SYNTAX = /[|;&<>`(\n\r]/u
const RECURSIVE_REMOVE = /\brm\s+-[a-z]*r[a-z]*\b/iu

// Flags that make a listed command write or run something: git branch deletes, moves, copies or retargets; rg and grep run a preprocessor; git diff, log and show write a file
const BRANCH_WRITES =
  /^(?:-[a-z]*[cdfmtu]|--(?:delete|move|copy|force|set-upstream-to|unset-upstream|edit-description|track|no-track|create-reflog)(?:=|$))/iu
const PREPROCESSOR = /^--pre(?:-glob)?(?:=|$)/u
const OUTPUT_FILE = /^--output(?:=|$)/u
const LISTING = new Set(['--list', '-l'])

// A word of a command, and where it leads once it is resolved against the workspace; null when only the shell knows (~, $VAR) or there is no workspace
export interface Place {
  readonly word: string
  readonly resolved: string | null
}

// The words of a simple command with the quotes dropped: good enough to tell what a command names, never to run it
const wordsOf = (command: string): readonly string[] =>
  command
    .split(/\s+/u)
    .map((word) => word.replaceAll(/["']/gu, ''))
    .filter((word) => word !== '')

// An argument names itself and a --flag=value its value; any other flag names nothing
const namedBy = (word: string): readonly string[] => {
  if (!word.startsWith('-')) {
    return [word]
  }
  const equals = word.indexOf('=')
  return word.startsWith('--') && equals > 0 ? [word.slice(equals + 1)] : []
}

const placeOf = (word: string, root: string): Place => {
  const expanded = word.startsWith('~') || word.includes('$')
  return { word, resolved: expanded || root === '' ? null : posix.resolve(root, word) }
}

// What the words after the command, and after the subcommand of git, name
const placesAfter = (words: readonly string[], skip: number, root: string): readonly Place[] =>
  words
    .slice(skip)
    .flatMap((word) => namedBy(word))
    .map((word) => placeOf(word, root))

// Strictly under the root: neither the root itself nor a path that climbs out of it
export const isUnder = (root: string, target: string): boolean => {
  const relation = posix.relative(root, target)
  return relation !== '' && relation !== '..' && !relation.startsWith('../')
}

const isWithin = (root: string, place: Place): boolean =>
  place.resolved !== null && (place.resolved === root || isUnder(root, place.resolved))

// The flags of a listed command that make it more than a read
function writes(words: readonly string[]): boolean {
  const [command, subcommand] = words
  if (command === 'rg' || command === 'grep') {
    return words.some((word) => PREPROCESSOR.test(word))
  }
  if (command !== 'git') {
    return false
  }
  if (subcommand === 'branch') {
    const positional = words.slice(2).some((word) => !word.startsWith('-'))
    const listing = words.some((word) => LISTING.has(word))
    return words.some((word) => BRANCH_WRITES.test(word)) || (positional && !listing)
  }
  return words.some((word) => OUTPUT_FILE.test(word))
}

// Every place a command names, after the command and the subcommand of git
export const placesOf = (command: string, root: string): readonly Place[] => {
  const words = wordsOf(command)
  return placesAfter(words, words[0] === 'git' ? 2 : 1, root)
}

// Read-only is a property of the whole command: a listed one, alone, with no writing flag, naming nothing outside the workspace
export const isReadOnly = (command: string, root: string): boolean =>
  READ_ONLY.test(command) &&
  !SHELL_SYNTAX.test(command) &&
  !writes(wordsOf(command)) &&
  placesOf(command, root).every((place) => isWithin(root, place))

// A recursive removal is outside unless everything it names lies strictly inside the workspace; with shell syntax around it nobody can tell
export const removesOutside = (command: string, root: string): boolean =>
  RECURSIVE_REMOVE.test(command) &&
  (root === '' ||
    SHELL_SYNTAX.test(command) ||
    placesOf(command, root).some(
      (place) => place.resolved === null || !isUnder(root, place.resolved),
    ))
