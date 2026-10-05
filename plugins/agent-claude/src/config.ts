import { z } from 'zod'

const SettingSources = z.array(z.enum(['user', 'project', 'local']))
const ClaudeConfigSchema = z.strictObject({
  executable: z.optional(z.string().min(1)),
  settingSources: z.optional(SettingSources),
})

export type ClaudeConfig = z.infer<typeof ClaudeConfigSchema>

const describeIssue = (issue: z.core.$ZodIssue): string =>
  issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`

// The providers.claude section as the adapter reads it; a key it does not know is a configuration error, told as such
export const claudeConfigOf = (providerConfig: Readonly<Record<string, unknown>>): ClaudeConfig => {
  const parsed = ClaudeConfigSchema.safeParse(providerConfig)
  if (!parsed.success) {
    throw new Error(`providers.claude: ${parsed.error.issues.map(describeIssue).join('; ')}`)
  }
  return parsed.data
}
