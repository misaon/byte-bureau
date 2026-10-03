// CSpell:ignore cdfmtu
import path from 'node:path'
import { shellWords, type ShellWord } from './shell-words.js'

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
// The letters of a cluster of short flags, such as -rf in -rf/etc/passwd
const SHORT_FLAGS = /^-[a-z]+/iu
const OPTIONS_END = '--'

// A word of a command, and where it leads once it is resolved against the workspace; null when only the shell knows (~, $VAR) or there is no workspace
export interface Place {
  readonly word: string
  readonly resolved: string | null
}

// What may follow each letter of a cluster of short flags: -rf/etc/passwd is -r -f /etc/passwd, and -f takes the rest
function attachedTo(flags: string): readonly string[] {
  const match = SHORT_FLAGS.exec(flags)
  const end = match === null ? 1 : match[0].length
  const tails: string[] = []
  for (let index = 2; index <= end; index += 1) {
    tails.push(flags.slice(index))
  }
  return tails.filter((tail) => tail !== '')
}

// An operand names itself, a --flag=value its value and a cluster of short flags whatever is attached to it
const namedBy = (word: string): readonly string[] => {
  if (!word.startsWith('-')) {
    return [word]
  }
  if (!word.startsWith(OPTIONS_END)) {
    return attachedTo(word)
  }
  const equals = word.indexOf('=')
  return equals > 0 ? [word.slice(equals + 1)] : []
}

// After -- every word is an operand, one that starts with a dash too
function namesOf(words: readonly string[]): readonly string[] {
  const end = words.indexOf(OPTIONS_END)
  const options = end === -1 ? words : words.slice(0, end)
  const operands = end === -1 ? [] : words.slice(end + 1)
  return [...options.flatMap((word) => namedBy(word)), ...operands]
}

// A git revision names a path after its colon: HEAD:.env, :0:src/a.ts, -L1,5:file
const withRevisionPaths = (name: string): readonly string[] => [
  name,
  ...[...name.matchAll(/:/gu)].map((colon) => name.slice(colon.index + 1)),
]

const placeOf = (word: string, root: string): Place => {
  const expanded = word.startsWith('~') || word.includes('$')
  return { word, resolved: expanded || root === '' ? null : posix.resolve(root, word) }
}

const textsOf = (words: readonly ShellWord[]): readonly string[] => words.map((word) => word.text)

// What the words after the command, and after the subcommand of git, name
function placesIn(words: readonly string[], root: string): readonly Place[] {
  const git = words[0] === 'git'
  const names = namesOf(words.slice(git ? 2 : 1))
  const named = git ? names.flatMap((name) => withRevisionPaths(name)) : names
  return named.map((name) => placeOf(name, root))
}

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

// Every place a command names, after the command and the subcommand of git, with its quotes and escapes removed
export const placesOf = (command: string, root: string): readonly Place[] =>
  placesIn(textsOf(shellWords(command)), root)

// Read-only is a property of the whole command: a listed one, alone, with no word the shell expands and no writing flag, naming nothing outside the workspace
export function isReadOnly(command: string, root: string): boolean {
  const words = shellWords(command)
  const texts = textsOf(words)
  return (
    READ_ONLY.test(command) &&
    !SHELL_SYNTAX.test(command) &&
    words.every((word) => !word.expanded) &&
    !writes(texts) &&
    placesIn(texts, root).every((place) => isWithin(root, place))
  )
}

// A recursive removal is outside unless everything it names lies strictly inside the workspace; with shell syntax around it nobody can tell
export const removesOutside = (command: string, root: string): boolean =>
  RECURSIVE_REMOVE.test(command) &&
  (root === '' ||
    SHELL_SYNTAX.test(command) ||
    placesOf(command, root).some(
      (place) => place.resolved === null || !isUnder(root, place.resolved),
    ))
