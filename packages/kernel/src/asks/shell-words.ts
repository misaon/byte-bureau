// The words of a simple command as a POSIX shell splits them, read only far enough for the ask policy to judge them

// Outside quotes these make the shell rewrite a word: an escape, a glob, braces or a variable
const EXPANDS = new Set(['\\', '*', '?', '[', '{', '$'])
// Inside double quotes a variable, a substitution and an escape still work
const EXPANDS_QUOTED = new Set(['\\', '$', '`'])
// Inside double quotes a backslash escapes only these; before any other character it stays
const ESCAPABLE_QUOTED = new Set(['\\', '$', '`', '"', '\n'])
const BLANK = /\s/u

export interface ShellWord {
  // The word as its program receives it when nothing is expanded: quotes and escapes removed
  readonly text: string
  // The shell rewrites the word first (~ at its start, a variable, a glob, braces, an escape), so it cannot be read as written
  readonly expanded: boolean
}

interface Scan {
  readonly words: ShellWord[]
  text: string
  // A word has begun, which an empty pair of quotes does too
  open: boolean
  expanded: boolean
  quote: '' | "'" | '"'
  escaping: boolean
}

function close(scan: Scan): void {
  if (scan.open) {
    scan.words.push({ text: scan.text, expanded: scan.expanded })
  }
  scan.text = ''
  scan.open = false
  scan.expanded = false
}

function add(scan: Scan, text: string, expands: boolean): void {
  scan.text += text
  scan.open = true
  scan.expanded ||= expands
}

function escaped(scan: Scan, char: string): void {
  scan.escaping = false
  const kept = scan.quote === '"' && !ESCAPABLE_QUOTED.has(char)
  add(scan, kept ? `\\${char}` : char, false)
}

function quoted(scan: Scan, char: string): void {
  if (char === scan.quote) {
    scan.quote = ''
  } else if (scan.quote === '"' && char === '\\') {
    scan.escaping = true
    add(scan, '', true)
  } else {
    add(scan, char, scan.quote === '"' && EXPANDS_QUOTED.has(char))
  }
}

function unquoted(scan: Scan, char: string): void {
  if (BLANK.test(char)) {
    close(scan)
  } else if (char === "'" || char === '"') {
    scan.quote = char
    add(scan, '', false)
  } else {
    scan.escaping = char === '\\'
    add(scan, scan.escaping ? '' : char, EXPANDS.has(char) || (char === '~' && !scan.open))
  }
}

function step(scan: Scan, char: string): void {
  if (scan.escaping) {
    escaped(scan, char)
  } else if (scan.quote === '') {
    unquoted(scan, char)
  } else {
    quoted(scan, char)
  }
}

// An unterminated quote or a trailing escape leaves the word to the shell's guess, which counts as expanded
export function shellWords(command: string): readonly ShellWord[] {
  const scan: Scan = {
    words: [],
    text: '',
    open: false,
    expanded: false,
    quote: '',
    escaping: false,
  }
  for (const char of command) {
    step(scan, char)
  }
  scan.expanded ||= scan.quote !== '' || scan.escaping
  close(scan)
  return scan.words
}
