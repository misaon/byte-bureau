import type { PermissionMode } from '@bytebureau/protocol'

export interface ToolCall {
  readonly name: string
  readonly input: unknown
}

interface PermissionRecommendation {
  readonly recommended: 'allow' | 'deny' | null
  readonly ruleId: string | null
}

// The parts of a tool call the rules look at; the fields a tool lacks read as empty text
interface Facts {
  readonly name: string
  readonly command: string
  readonly filePath: string
  readonly workspacePath: string
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

const inWorkspace = ({ filePath, workspacePath }: Facts): boolean =>
  filePath.startsWith(`${workspacePath}/`)

// Rules are evaluated top-down and the first match decides, so the deny rules come first
const RULES: readonly Rule[] = [
  { id: 'force-push', verdict: 'deny', applies: ({ command }) => FORCE_PUSH.test(command) },
  {
    id: 'rm-outside-workspace',
    verdict: 'deny',
    applies: ({ command, workspacePath }) =>
      RECURSIVE_REMOVE.test(command) && !command.includes(workspacePath),
  },
  { id: 'secrets-path', verdict: 'deny', applies: ({ filePath }) => SECRETS.test(filePath) },
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

const NO_RECOMMENDATION: PermissionRecommendation = { recommended: null, ruleId: null }

export function recommendForPermission(
  toolCall: ToolCall,
  workspacePath: string,
  mode: PermissionMode,
): PermissionRecommendation {
  const facts: Facts = {
    name: toolCall.name,
    command: field(toolCall.input, 'command'),
    filePath: field(toolCall.input, 'file_path') || field(toolCall.input, 'path'),
    workspacePath,
    mode,
  }
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
