import path from 'node:path'
import type { PermissionMode } from '@bytebureau/protocol'

const { posix } = path

export interface ToolCall {
  readonly name: string
  readonly input: unknown
}

export interface PermissionRecommendation {
  readonly recommended: 'allow' | 'deny' | null
  readonly ruleId: string | null
}

// The parts of a tool call the rules look at; the fields a tool lacks read as empty text
interface Facts {
  readonly name: string
  readonly command: string
  // The file as the tool names it, and the file it lands on once `.` and `..` are resolved
  readonly filePath: string
  readonly target: string
  readonly workspacePath: string
  // The workspace when it is an absolute path, else empty: nothing is inside a workspace that is not one
  readonly root: string
  readonly mode: PermissionMode
}

interface Rule {
  readonly id: string
  readonly verdict: 'allow' | 'deny'
  readonly applies: (facts: Facts) => boolean
}

const FORCE_PUSH = /\bgit push\b.*(?:--force|-f\b|\+)/u
const RECURSIVE_REMOVE = /\brm\s+-[a-z]*r[a-z]*f?\b/u
// A listed command named in full: its word ends at a space or at the end of the command; find is not listed, its -delete and -exec remove and run
const READ_ONLY =
  /^(?:git (?:status|log|diff|show|branch|rev-parse)|ls|cat|head|tail|rg|grep|wc|pwd|echo)(?:[ \t]|$)/u
// What makes a command more than one simple command, or more than a read: a pipe, a list, a background job, a redirection, a substitution (parentheses cover $(), <() and zsh =()) or a line break
const SHELL_SYNTAX = /[|;&<>`(\n\r]/u
// A .env file or one of its .env.* variants, a certificate, a private key, a credentials file, anything under .ssh
const SECRETS =
  /(?:^|\/)\.env(?:\.|$)|\.pem$|(?:^|\/)(?:id_(?:rsa|ed25519)|\.npmrc|\.netrc)$|(?:^|\/)\.ssh\//u
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch', 'curl', 'wget'])

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null

const field = (input: unknown, key: string): string => {
  const value = isRecord(input) ? input[key] : undefined
  return typeof value === 'string' ? value : ''
}

// Read-only is a property of the whole command, not of its first word
const isReadOnly = (command: string): boolean =>
  READ_ONLY.test(command) && !SHELL_SYNTAX.test(command)

// Strictly under the root: neither the root itself nor a path that climbs out of it
const isUnder = (root: string, target: string): boolean => {
  const relation = posix.relative(root, target)
  return relation !== '' && relation !== '..' && !relation.startsWith('../')
}

// The check is lexical: a symlink inside the workspace that points out of it cannot be told from a plain path, only the file system knows
// With no absolute workspace nothing is inside it, whatever the path looks like
const inWorkspace = ({ root, target }: Facts): boolean =>
  root !== '' && target !== '' && isUnder(root, target)

// Rules are evaluated top-down and the first match decides, so the deny rules come first
const RULES: readonly Rule[] = [
  { id: 'force-push', verdict: 'deny', applies: ({ command }) => FORCE_PUSH.test(command) },
  {
    id: 'rm-outside-workspace',
    verdict: 'deny',
    // Without a workspace every recursive removal is outside it
    applies: ({ command, workspacePath }) =>
      RECURSIVE_REMOVE.test(command) && (workspacePath === '' || !command.includes(workspacePath)),
  },
  {
    id: 'secrets-path',
    verdict: 'deny',
    applies: ({ filePath, target }) => SECRETS.test(filePath) || SECRETS.test(target),
  },
  {
    id: 'network-in-supervised',
    verdict: 'deny',
    applies: ({ mode, name }) => mode === 'supervised' && NETWORK_TOOLS.has(name),
  },
  { id: 'read-only-command', verdict: 'allow', applies: ({ command }) => isReadOnly(command) },
  {
    id: 'in-workspace-read',
    verdict: 'allow',
    applies: (facts) => facts.name === 'Read' && inWorkspace(facts),
  },
  { id: 'in-workspace-edit', verdict: 'allow', applies: inWorkspace },
]

export const NO_RECOMMENDATION: PermissionRecommendation = { recommended: null, ruleId: null }

// A relative path is read against the workspace, where the agent works; without an absolute workspace it can only be tidied
const resolveTarget = (filePath: string, workspacePath: string): string => {
  if (filePath === '') {
    return ''
  }
  return posix.isAbsolute(workspacePath)
    ? posix.resolve(workspacePath, filePath)
    : posix.normalize(filePath)
}

const factsOf = (toolCall: ToolCall, workspacePath: string, mode: PermissionMode): Facts => {
  const filePath = field(toolCall.input, 'file_path') || field(toolCall.input, 'path')
  return {
    name: toolCall.name,
    command: field(toolCall.input, 'command'),
    filePath,
    target: resolveTarget(filePath, workspacePath),
    workspacePath,
    root: posix.isAbsolute(workspacePath) ? workspacePath : '',
    mode,
  }
}

export function recommendForPermission(
  toolCall: ToolCall,
  workspacePath: string,
  mode: PermissionMode,
): PermissionRecommendation {
  const facts = factsOf(toolCall, workspacePath, mode)
  const rule = RULES.find((candidate) => candidate.applies(facts))
  return rule === undefined ? NO_RECOMMENDATION : { recommended: rule.verdict, ruleId: rule.id }
}

const UNIT_MILLIS: ReadonlyMap<string, number> = new Map([
  ['ms', 1],
  ['s', 1000],
  ['m', 60_000],
  ['h', 3_600_000],
])

const DURATION = /^(?<amount>\d+)\s*(?<unit>ms|s|m|h)$/u

type Parts = Readonly<Record<string, string | undefined>>

export function parseDuration(text: string): number {
  const match = DURATION.exec(text.trim())
  const { amount, unit }: Parts = match === null ? {} : (match.groups ?? {})
  const factor = unit === undefined ? undefined : UNIT_MILLIS.get(unit)
  if (amount === undefined || factor === undefined) {
    throw new Error(`invalid duration: ${text}`)
  }
  return Number(amount) * factor
}
