import { ProviderConfigError, type ProjectTrust } from '@bytebureau/plugin-api'
import { z } from 'zod'
import { PRESETS, providerIdOf, type Preset, type PresetId } from './presets.js'

const Name = z.string().min(1)
const Words = z.array(z.string())
const Variables = z.record(z.string(), z.string())
// The providers["acp:<preset>"] section, which the kernel hands over without passEnv: the custom preset itself, or the overrides of a built-in one
const PresetEntry = z.strictObject({
  command: z.exactOptional(Name),
  args: z.exactOptional(Words),
  env: z.exactOptional(Variables),
  configDirEnv: z.exactOptional(Name),
  apiKeyEnv: z.exactOptional(Name),
  installHint: z.exactOptional(Name),
  loginHint: z.exactOptional(Name),
})

type Entry = z.infer<typeof PresetEntry>

// What the custom preset is before a project names its command
export const CUSTOM = {
  displayName: 'Custom agent (ACP)',
  installHint: 'install it, or point providers["acp:custom"].command at the agent to run',
  loginHint: 'the login command of that agent',
} as const

const describeIssue = (issue: z.core.$ZodIssue): string =>
  issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`

const entryOf = (id: PresetId, providerConfig: Readonly<Record<string, unknown>>): Entry => {
  const parsed = PresetEntry.safeParse(providerConfig)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(describeIssue).join('; ')
    throw new ProviderConfigError(`providers["${providerIdOf(id)}"]: ${issues}`)
  }
  return parsed.data
}

const NO_COMMAND = 'providers["acp:custom"].command is not configured'

// The hints a project configures win over the defaults
// A command the kernel withheld, as the user does not trust it, is refused with the way to trust it
const customOf = (entry: Entry, trust: ProjectTrust | undefined): Preset => {
  const { command } = entry
  if (command === undefined) {
    const withheld = trust !== undefined && trust.withheld.includes('command')
    throw new ProviderConfigError(withheld ? `${NO_COMMAND}; ${trust.hint}` : NO_COMMAND)
  }
  return { id: 'custom', args: [], env: {}, ...CUSTOM, ...entry, command }
}

// The preset a session runs: a built-in one with the overrides of its section, or the custom one its section describes
export const presetOf = (
  id: PresetId,
  providerConfig: Readonly<Record<string, unknown>>,
  trust?: ProjectTrust,
): Preset => {
  const entry = entryOf(id, providerConfig)
  return id === 'custom' ? customOf(entry, trust) : { ...PRESETS[id], ...entry }
}
