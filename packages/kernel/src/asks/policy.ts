import path from 'node:path'
import type { PermissionMode } from '@bytebureau/protocol'
import { isReadOnly, isUnder, placesOf, removesOutside, type Place } from './policy-command.js'

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
  // What the command names, resolved against the workspace
  readonly places: readonly Place[]
  // The file as the tool names it, and the file it lands on once `.` and `..` are resolved
  readonly filePath: string
  readonly target: string
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
// A .env file or one of its .env.* variants, a certificate, a private key, a credentials file, anything under .ssh, in any case
const SECRETS =
  /(?:^|\/)\.env(?:\.|$)|\.pem$|(?:^|\/)(?:id_(?:rsa|ed25519)|\.npmrc|\.netrc)$|(?:^|\/)\.ssh\/|(?:^|\/)\.aws\/credentials$/iu
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch', 'curl', 'wget'])

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null

const field = (input: unknown, key: string): string => {
  const value = isRecord(input) ? input[key] : undefined
  return typeof value === 'string' ? value : ''
}

// The check is lexical: a symlink inside the workspace that points out of it cannot be told from a plain path, only the file system knows
// With no absolute workspace nothing is inside it, whatever the path looks like
const inWorkspace = ({ root, target }: Facts): boolean =>
  root !== '' && target !== '' && isUnder(root, target)

const namesSecret = ({ filePath, target, places }: Facts): boolean =>
  SECRETS.test(filePath) ||
  SECRETS.test(target) ||
  places.some((place) => SECRETS.test(place.word) || SECRETS.test(place.resolved ?? ''))

// Rules are evaluated top-down and the first match decides, so the deny rules come first
const RULES: readonly Rule[] = [
  { id: 'force-push', verdict: 'deny', applies: ({ command }) => FORCE_PUSH.test(command) },
  {
    id: 'rm-outside-workspace',
    verdict: 'deny',
    applies: ({ command, root }) => removesOutside(command, root),
  },
  { id: 'secrets-path', verdict: 'deny', applies: namesSecret },
  {
    id: 'network-in-supervised',
    verdict: 'deny',
    applies: ({ mode, name }) => mode === 'supervised' && NETWORK_TOOLS.has(name),
  },
  {
    id: 'read-only-command',
    verdict: 'allow',
    applies: ({ command, root }) => command !== '' && isReadOnly(command, root),
  },
  {
    id: 'in-workspace-read',
    verdict: 'allow',
    applies: (facts) => facts.name === 'Read' && inWorkspace(facts),
  },
  { id: 'in-workspace-edit', verdict: 'allow', applies: inWorkspace },
]

export const NO_RECOMMENDATION: PermissionRecommendation = { recommended: null, ruleId: null }

// A relative path is read against the workspace, where the agent works; without an absolute workspace it can only be tidied
const resolveTarget = (filePath: string, root: string): string => {
  if (filePath === '') {
    return ''
  }
  return root === '' ? posix.normalize(filePath) : posix.resolve(root, filePath)
}

// A glob searches its pattern below its path, so the two together say where it reaches
const filePathOf = ({ name, input }: ToolCall): string => {
  const pattern = field(input, 'pattern')
  if (name === 'Glob' && pattern !== '') {
    return posix.isAbsolute(pattern) ? pattern : posix.join(field(input, 'path') || '.', pattern)
  }
  return field(input, 'file_path') || field(input, 'path')
}

const factsOf = (toolCall: ToolCall, workspacePath: string, mode: PermissionMode): Facts => {
  const root = posix.isAbsolute(workspacePath) ? workspacePath : ''
  const command = field(toolCall.input, 'command')
  const filePath = filePathOf(toolCall)
  return {
    name: toolCall.name,
    command,
    places: placesOf(command, root),
    filePath,
    target: resolveTarget(filePath, root),
    root,
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
