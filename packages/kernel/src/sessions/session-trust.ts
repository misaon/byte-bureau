import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ProjectTrust } from '@bytebureau/plugin-api'
import { defaultProjectConfig, type UserConfig } from '@bytebureau/protocol'

type Section = Readonly<Record<string, unknown>>

// The keys a project's files set only under trust: what runs, its arguments and environment, and what the person is told to run
const GATED_KEYS = ['command', 'executable', 'args', 'env', 'installHint', 'loginHint'] as const
// What names the command that runs, and what a command the user trusts releases: itself, by its absolute path, and its arguments
const NAMING_KEYS: ReadonlySet<string> = new Set(['command', 'executable'])
const COMMAND_KEYS: ReadonlySet<string> = new Set(['command', 'executable', 'args'])
const SUFFIXES = process.platform === 'win32' ? ['', '.exe', '.cmd'] : ['']

// What the trust of a project is decided from
export interface TrustQuestion {
  // The providers.<id> section the session's provider would get, passEnv already taken out
  readonly section: Section
  readonly providerId: string
  readonly projectPath: string
  readonly user: UserConfig
  // The user configuration file, where the person trusts a project or a command
  readonly userFile: string
  // The PATH of the daemon, on which a bare name the user trusts is found
  readonly searchPath: string
}

export interface Gated {
  readonly providerConfig: Section
  readonly trust: ProjectTrust
  // What was not used and why, in the words of a warning: the kernel logs each and tells each as a session warning
  readonly warnings: readonly string[]
}

// Whether the project trusts the command it names, and what each of its naming keys then runs as
interface CommandTrust {
  readonly resolved: Readonly<Record<string, string>>
  // Why the command, and its arguments with it, is withheld; nothing when the user trusts it
  readonly refusal?: string | undefined
}

const defaultsOf = (providerId: string): Section => {
  const { providers } = defaultProjectConfig
  const section = providers === undefined ? undefined : providers[providerId]
  return section ?? {}
}

const sameValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

// The gated keys the project's files set: the defaults are the only other source of a provider section, and a value they hold already needs no trust
const suppliedKeys = (section: Section, defaults: Section): readonly string[] =>
  GATED_KEYS.filter(
    (key) =>
      Object.hasOwn(section, key) &&
      !(Object.hasOwn(defaults, key) && sameValue(section[key], defaults[key])),
  )

// A path as the file system has it, so a link or a trailing slash in the user file still names the project
const canonical = (entry: string): string => {
  try {
    return realpathSync(entry)
  } catch {
    return path.resolve(entry)
  }
}

const trustsProject = (projects: readonly string[], projectPath: string): boolean => {
  const project = canonical(projectPath)
  return projects.some((entry) => canonical(entry) === project)
}

const isExecutable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

// A bare name as the daemon's PATH finds it, through its absolute directories alone, so a project's directory never lends it a binary
export const resolveOnPath = (name: string, searchPath: string): string | undefined =>
  searchPath
    .split(path.delimiter)
    .filter((directory) => path.isAbsolute(directory))
    .flatMap((directory) => SUFFIXES.map((suffix) => path.join(directory, `${name}${suffix}`)))
    .find((candidate) => isExecutable(candidate))

// What a trusted command runs as: an absolute path as it is, a bare name as the PATH finds it; a relative path is trusted by no name
const resolvedCommand = (name: string, searchPath: string): string | undefined => {
  if (path.isAbsolute(name)) {
    return name
  }
  return name.includes('/') || name.includes(path.sep) ? undefined : resolveOnPath(name, searchPath)
}

export const trustHintOf = (userFile: string): string =>
  `the project names a command the user configuration does not trust: add it to trust.commands, or the project to trust.projects, in ${userFile}`

const projectOnlyHintOf = (userFile: string): string =>
  `only a project the user configuration trusts sets them: add the project to trust.projects in ${userFile}`

// The naming keys of a trusted command, each as the absolute path it runs as, or why one of them cannot run
const resolvedTrustOf = (question: TrustQuestion, naming: readonly string[]): CommandTrust => {
  const resolved = naming.map(
    (key) => [key, resolvedCommand(String(question.section[key]), question.searchPath)] as const,
  )
  const missing = resolved.find(([, found]) => found === undefined)
  if (missing !== undefined) {
    const name = JSON.stringify(question.section[missing[0]])
    const refusal = `the command ${name} that trust.commands names is not on the daemon's PATH: install it there, or add the project to trust.projects in ${question.userFile}`
    return { resolved: {}, refusal }
  }
  return { resolved: Object.fromEntries(resolved.map(([key, found]) => [key, found ?? ''])) }
}

// A command the project names runs, with its arguments, when the user trusts that exact name or path and the daemon finds it
const commandTrustOf = (question: TrustQuestion, supplied: readonly string[]): CommandTrust => {
  const naming = supplied.filter((key) => NAMING_KEYS.has(key))
  const trusted = question.user.trust === undefined ? [] : (question.user.trust.commands ?? [])
  if (naming.length === 0) {
    return { resolved: {}, refusal: projectOnlyHintOf(question.userFile) }
  }
  const named = naming.map((key) => question.section[key])
  if (!named.every((name) => typeof name === 'string' && trusted.includes(name))) {
    return { resolved: {}, refusal: trustHintOf(question.userFile) }
  }
  return resolvedTrustOf(question, naming)
}

// The key as a person writes it: providers.claude.executable, providers["acp:custom"].command
export const providerKeyOf = (providerId: string, key: string): string =>
  /^[A-Za-z_$][\w$]*$/u.test(providerId)
    ? `providers.${providerId}.${key}`
    : `providers[${JSON.stringify(providerId)}].${key}`

// The words of a warning for keys withheld for one reason
const warningText = (question: TrustQuestion, keys: readonly string[], reason: string): string => {
  const named = keys.map((key) => providerKeyOf(question.providerId, key)).join(', ')
  return `not using ${named} of the project ${question.projectPath}: ${reason}`
}

// One warning a reason, naming every key withheld for it: a command's keys for its refusal, the others for want of the project's trust
const warningsOf = (
  question: TrustQuestion,
  withheld: readonly string[],
  refusal: string | undefined,
): readonly string[] => {
  const projectOnly = projectOnlyHintOf(question.userFile)
  const reasonOf = (key: string): string =>
    COMMAND_KEYS.has(key) ? (refusal ?? projectOnly) : projectOnly
  const reasons = [...new Set(withheld.map((key) => reasonOf(key)))]
  return reasons.map((reason) =>
    warningText(
      question,
      withheld.filter((key) => reasonOf(key) === reason),
      reason,
    ),
  )
}

// A trusted project sets everything; a trusted command runs by its absolute path with the project's arguments, but no environment or hints of it
export function gateProviderConfig(question: TrustQuestion): Gated {
  const trust = question.user.trust ?? {}
  const project = trustsProject(trust.projects ?? [], question.projectPath)
  const supplied = project ? [] : suppliedKeys(question.section, defaultsOf(question.providerId))
  const command = commandTrustOf(question, supplied)
  const withheld = supplied.filter((key) => command.refusal !== undefined || !COMMAND_KEYS.has(key))
  const kept = Object.entries(question.section).filter(([key]) => !withheld.includes(key))
  return {
    providerConfig: { ...Object.fromEntries(kept), ...(project ? {} : command.resolved) },
    trust: { project, withheld, hint: command.refusal ?? trustHintOf(question.userFile) },
    warnings: warningsOf(question, withheld, command.refusal),
  }
}
