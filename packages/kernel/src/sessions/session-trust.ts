import { realpathSync } from 'node:fs'
import path from 'node:path'
import type { ProjectTrust } from '@bytebureau/plugin-api'
import { defaultProjectConfig, type UserConfig } from '@bytebureau/protocol'

type Section = Readonly<Record<string, unknown>>

// The keys of a provider section that run something, and those of them that name what runs
const COMMAND_KEYS = ['command', 'args', 'env', 'executable'] as const
const NAMING_KEYS: ReadonlySet<string> = new Set(['command', 'executable'])

// What the trust of a project is decided from
export interface TrustQuestion {
  // The providers.<id> section the session's provider would get, passEnv already taken out
  readonly section: Section
  readonly providerId: string
  readonly projectPath: string
  readonly user: UserConfig
  // The user configuration file, where the person trusts a project or a command
  readonly userFile: string
}

export interface Gated {
  readonly providerConfig: Section
  readonly trust: ProjectTrust
  // The commands the project named that were not trusted, for the warning
  readonly commands: readonly string[]
}

const defaultsOf = (providerId: string): Section => {
  const { providers } = defaultProjectConfig
  const section = providers === undefined ? undefined : providers[providerId]
  return section ?? {}
}

const sameValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

// The command keys the project's files set: the defaults are the only other source of a provider section, and a value they hold already needs no trust
const suppliedKeys = (section: Section, defaults: Section): readonly string[] =>
  COMMAND_KEYS.filter(
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

// Every command the project names is one the user trusts by that exact name or path
const trustsCommands = (commands: readonly string[], named: readonly unknown[]): boolean =>
  named.length > 0 && named.every((name) => typeof name === 'string' && commands.includes(name))

export const trustHintOf = (userFile: string): string =>
  `the project names a command the user configuration does not trust: add it to trust.commands, or the project to trust.projects, in ${userFile}`

// The commands a project's files name run only when the user configuration trusts the project or that exact command; otherwise they are withheld
export function gateProviderConfig(question: TrustQuestion): Gated {
  const trust = question.user.trust ?? {}
  const project = trustsProject(trust.projects ?? [], question.projectPath)
  const supplied = suppliedKeys(question.section, defaultsOf(question.providerId))
  const named = supplied.filter((key) => NAMING_KEYS.has(key)).map((key) => question.section[key])
  const trusted = project || supplied.length === 0 || trustsCommands(trust.commands ?? [], named)
  const withheld = trusted ? [] : supplied
  return {
    providerConfig: Object.fromEntries(
      Object.entries(question.section).filter(([key]) => !withheld.includes(key)),
    ),
    trust: { project, withheld, hint: trustHintOf(question.userFile) },
    commands: trusted ? [] : named.filter((name): name is string => typeof name === 'string'),
  }
}

// The key as a person writes it: providers.claude.executable, providers["acp:custom"].command
export const providerKeyOf = (providerId: string, key: string): string =>
  /^[A-Za-z_$][\w$]*$/u.test(providerId)
    ? `providers.${providerId}.${key}`
    : `providers[${JSON.stringify(providerId)}].${key}`
