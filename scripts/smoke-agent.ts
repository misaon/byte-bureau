// What a real-agent smoke runs and how it reads what the CLI printed; the runs themselves are in smoke-run.ts

// A smoke drives a real agent, on the subscription or the key of whoever runs it: it runs only when this is 1, and never in CI
export const SMOKE_GUARD = 'SMOKE_REAL_AGENTS'

// The prompt of spec §16, acceptance criteria 1 to 3
export const PROMPT = 'Create src/hello.ts exporting hello()'

type Env = Readonly<Record<string, string | undefined>>

// One JSON record a command printed: an event of a run, or the record of a command
export type JsonRecord = Readonly<Record<string, unknown>>

export interface SmokePlan {
  // The package.json script that runs it
  readonly script: string
  readonly provider: string
  // SMOKE_PROFILE: a profile id of the provider, which the smoke adds to its throwaway home as a login profile first
  readonly profile: string | undefined
  // The other variables the smoke reads, for the lines that say how to run it
  readonly variables: readonly string[]
}

// The profile a smoke runs under: the nameless login of the provider, or a login profile it adds first
export type ProfileChoice =
  | { readonly kind: 'nameless' }
  | { readonly kind: 'login'; readonly id: string; readonly name: string }
  | { readonly kind: 'refused'; readonly reason: string }

export interface Summary {
  // The usage of the last turn.completed, as the kernel published it
  readonly usage: JsonRecord | undefined
  readonly rateLimit: boolean
  readonly contextPct: boolean
}

export const smokeAllowed = (env: Env): boolean => env[SMOKE_GUARD] === '1'

export const planOf = (env: Env, plan: Omit<SmokePlan, 'profile'>): SmokePlan => ({
  ...plan,
  profile: env['SMOKE_PROFILE'],
})

// What the smoke tells when it is not asked to run: what it does and how to run it
export function usageOf(plan: SmokePlan): string {
  const file = `scripts/${plan.script.replace(':', '-')}.ts`
  return [
    `${plan.script} runs ${plan.provider}, a real agent, on your own login; CI never runs it.`,
    `Run it with: bun run ${plan.script}   (or ${SMOKE_GUARD}=1 bun ${file})`,
    'It works on a throwaway BYTEBUREAU_HOME and repository, with a daemon from source that it stops at the end.',
    `SMOKE_PROFILE=${plan.provider}/<name> adds that login profile to the throwaway home and runs under it.`,
    ...plan.variables,
  ].join('\n')
}

// Without SMOKE_REAL_AGENTS=1 a smoke only says how to run it, and ends with exit code 0
export async function guarded(
  plan: SmokePlan,
  env: Env,
  run: (plan: SmokePlan) => Promise<number>,
): Promise<number> {
  if (!smokeAllowed(env)) {
    console.log(usageOf(plan))
    return 0
  }
  const code = await run(plan)
  return code
}

// A profile id is <provider>/<name>, and a name holds no slash
export function profileChoiceOf(plan: SmokePlan): ProfileChoice {
  const id = plan.profile ?? ''
  if (id === '') {
    return { kind: 'nameless' }
  }
  const slash = id.lastIndexOf('/')
  if (slash === -1 || id.slice(0, slash) !== plan.provider) {
    const reason = `SMOKE_PROFILE must be a profile id of ${plan.provider}, such as ${plan.provider}/work, not ${id}`
    return { kind: 'refused', reason }
  }
  return { kind: 'login', id, name: id.slice(slash + 1) }
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// A line of JSON output as its record; any other line is none
export function recordOf(line: string): JsonRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

// The session an event belongs to
export function sessionOf(event: JsonRecord): string | undefined {
  const id = event['sessionId']
  return typeof id === 'string' ? id : undefined
}

const ofType = (events: readonly JsonRecord[], type: string): readonly JsonRecord[] =>
  events.filter((event) => event['type'] === type)

const recordAt = (record: JsonRecord | undefined, key: string): JsonRecord | undefined => {
  const value = record === undefined ? undefined : record[key]
  return isRecord(value) ? value : undefined
}

const usageIn = (event: JsonRecord): JsonRecord | undefined =>
  recordAt(recordAt(event, 'payload'), 'usage')

// What the agent reported over a turn: its usage, rate limits and how much of the context it uses
export function summaryOf(events: readonly JsonRecord[]): Summary {
  const turnEnds = ofType(events, 'turn.completed')
  const last = turnEnds.at(-1)
  const usages = [...ofType(events, 'usage.updated'), ...turnEnds].map((event) => usageIn(event))
  return {
    usage: last === undefined ? undefined : usageIn(last),
    rateLimit: ofType(events, 'ratelimit.updated').length > 0,
    contextPct: usages.some(
      (usage) => usage !== undefined && typeof usage['contextPct'] === 'number',
    ),
  }
}

const yesOrNo = (value: boolean): string => (value ? 'yes' : 'no')

// What a command that follows a turn tells of it
export function reportOf(command: string, code: number, summary: Summary): readonly string[] {
  const usage =
    summary.usage === undefined ? 'none, no turn completed' : JSON.stringify(summary.usage)
  return [
    `${command} exited ${code}`,
    `usage of the turn: ${usage}`,
    `ratelimit.updated seen: ${yesOrNo(summary.rateLimit)}`,
    `contextPct seen: ${yesOrNo(summary.contextPct)}`,
  ]
}
