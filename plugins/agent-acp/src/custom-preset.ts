import { z } from 'zod'
import { PRESETS, type Preset, type PresetId } from './presets.js'

const Name = z.string().min(1)
const Words = z.array(z.string())
const Variables = z.record(z.string(), z.string())
const Entries = z.record(z.string(), z.unknown())
// What providers.acp.presets.<id> may say: the custom preset names its command, a built-in one may override any of its own
const PresetEntry = z.strictObject({
  command: z.exactOptional(Name),
  args: z.exactOptional(Words),
  env: z.exactOptional(Variables),
  configDirEnv: z.exactOptional(Name),
  apiKeyEnv: z.exactOptional(Name),
})
// Each provider reads the entry of its own preset; the others pass through
const AcpConfig = z.looseObject({ presets: z.exactOptional(Entries) })

type Entry = z.infer<typeof PresetEntry>

// What the custom preset is before a project names its command
export const CUSTOM = {
  displayName: 'Custom agent (ACP)',
  installHint: 'install it, or point providers.acp.presets.custom.command at the agent to run',
  loginHint: 'the login command of that agent',
} as const

const describeIssue = (issue: z.core.$ZodIssue): string =>
  issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`

const parsed = <Value>(schema: z.ZodType<Value>, value: unknown, where: string): Value => {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new Error(`${where}: ${result.error.issues.map(describeIssue).join('; ')}`)
  }
  return result.data
}

const entryOf = (id: PresetId, providerConfig: Readonly<Record<string, unknown>>): Entry => {
  const { presets } = parsed(AcpConfig, providerConfig, 'providers.acp')
  const entry = presets === undefined ? undefined : presets[id]
  return parsed(PresetEntry, entry ?? {}, `providers.acp.presets.${id}`)
}

const customOf = (entry: Entry): Preset => {
  const { command } = entry
  if (command === undefined) {
    throw new Error('providers.acp.presets.custom.command is not configured')
  }
  return { id: 'custom', args: [], env: {}, ...entry, command, ...CUSTOM }
}

// The preset a session runs: a built-in one with the overrides of its entry, or the custom one its entry describes
export const presetOf = (
  id: PresetId,
  providerConfig: Readonly<Record<string, unknown>>,
): Preset => {
  const entry = entryOf(id, providerConfig)
  return id === 'custom' ? customOf(entry) : { ...PRESETS[id], ...entry }
}
