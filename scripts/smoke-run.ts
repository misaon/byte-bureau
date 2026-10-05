import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  PROMPT,
  profileChoiceOf,
  reportOf,
  sessionOf,
  summaryOf,
  type JsonRecord,
  type ProfileChoice,
  type SmokePlan,
} from './smoke-agent.js'
import {
  atTheTerminal,
  cleanedUp,
  heldSignals,
  prepare,
  started,
  tell,
  throwaway,
  type Ran,
  type Running,
  type Throwaway,
} from './smoke-cli.js'

// What the resumed session is told: it reads the same whether or not the agent remembers the turn that was stopped
const GO_ON = 'Go on: create src/hello.ts exporting hello() unless it is there already'

// The exit code of a run whose session was stopped
const STOPPED = 3

interface Smoke extends Throwaway {
  readonly plan: SmokePlan
  // --provider, and --profile when the smoke runs under a profile
  readonly flags: readonly string[]
}

const command = async (smoke: Smoke, args: readonly string[]): Promise<Ran> => {
  const ran = await started(smoke, args).done
  return ran
}

// Whether the session of the events wrote the file of the prompt in its worktree
function helloOf(smoke: Smoke, ran: Ran): string {
  const id = ran.records.map((record) => sessionOf(record)).find((each) => each !== undefined)
  if (id === undefined) {
    return 'no session'
  }
  const file = path.join(smoke.repo, '.bytebureau', 'worktrees', id, 'src', 'hello.ts')
  return existsSync(file) ? 'yes' : 'no'
}

function told(smoke: Smoke, label: string, ran: Ran): void {
  for (const line of reportOf(label, ran.code, summaryOf(ran.records))) {
    tell(line)
  }
  tell(`src/hello.ts in the worktree: ${helloOf(smoke, ran)}`)
}

// The login profile SMOKE_PROFILE names, in the throwaway home: the CLI prints the login command and waits for it at a terminal
async function profileAdded(smoke: Smoke, choice: ProfileChoice): Promise<boolean> {
  if (choice.kind !== 'login') {
    return true
  }
  const code = await atTheTerminal(smoke, ['profiles', 'add', smoke.plan.provider, choice.name])
  tell(`profiles add exited ${code}`)
  return code === 0
}

// One turn to its end, every ask answered with its recommended option
async function firstRun(smoke: Smoke): Promise<number> {
  const args = ['run', PROMPT, '--project', smoke.repo, ...smoke.flags, '--json', '--yes']
  const ran = await command(smoke, args)
  told(smoke, 'run', ran)
  return ran.code
}

async function ended(running: Running): Promise<undefined> {
  await running.done
}

// Stopped where it waits, then resumed: the run that followed it ends as stopped
async function stoppedAndResumed(smoke: Smoke, id: string, running: Running): Promise<boolean> {
  tell(`session ${id} waits on an ask: sessions stop, then resume, then prompt`)
  const stop = await command(smoke, ['sessions', 'stop', id, '--json'])
  const run = await running.done
  const resume = await command(smoke, ['sessions', 'resume', id, '--json'])
  tell(`sessions stop exited ${stop.code}, its run ${run.code}, sessions resume ${resume.code}`)
  return stop.code === 0 && run.code === STOPPED && resume.code === 0
}

// The resumed session goes on with a prompt, and is completed, which lets go of its profile
async function promptedAndCompleted(smoke: Smoke, id: string): Promise<boolean> {
  const prompted = await command(smoke, ['sessions', 'prompt', id, GO_ON, '--json', '--yes'])
  told(smoke, 'sessions prompt', prompted)
  const complete = await command(smoke, ['sessions', 'complete', id, '--json'])
  tell(`sessions complete exited ${complete.code}`)
  return prompted.code === 0 && complete.code === 0
}

// The session a run waits in, from the session.waiting it printed once its agent asked
const waitingIn =
  (asked: PromiseWithResolvers<string>) =>
  (record: JsonRecord): void => {
    const id = sessionOf(record)
    if (record['type'] === 'session.waiting' && id !== undefined) {
      asked.resolve(id)
    }
  }

// A run that ended before its agent asked anything left no session to stop; only a real agent may ask nothing, the fake one always asks
/* v8 ignore start */
async function unasked(running: Running): Promise<number> {
  const ran = await running.done
  tell(`the second run ended (exit ${ran.code}) before its agent asked anything: no resume to show`)
  return ran.code
}
/* v8 ignore stop */

// Off a terminal and without --yes, the first ask of a second run waits: its session is stopped there, resumed and prompted again
async function resumePath(smoke: Smoke): Promise<number> {
  const asked = Promise.withResolvers<string>()
  const args = ['run', PROMPT, '--project', smoke.repo, ...smoke.flags, '--json']
  const running = started(smoke, args, waitingIn(asked))
  const id = await Promise.race([asked.promise, ended(running)])
  /* v8 ignore start */
  if (id === undefined) {
    const code = await unasked(running)
    return code
  }
  /* v8 ignore stop */
  const resumed =
    (await stoppedAndResumed(smoke, id, running)) && (await promptedAndCompleted(smoke, id))
  return resumed ? 0 : 1
}

// Where the smoke works, and how a person answers an ask that --yes leaves waiting
function introduced(smoke: Smoke): void {
  tell(`${smoke.plan.provider} on the throwaway home ${smoke.home} and repository ${smoke.repo}`)
  const cli = `BYTEBUREAU_HOME=${smoke.home} bun run --cwd apps/bytebureau src/main.ts`
  tell(
    `an ask --yes cannot answer waits; from another terminal, ${cli} ask ls, then ask answer <id>`,
  )
}

// 130 once a signal stopped the smoke, else 0 when every step ended 0
const exitOf = (smoke: Smoke, codes: readonly number[]): number => {
  if (smoke.stopping.received) {
    return 130
  }
  return codes.every((code) => code === 0) ? 0 : 1
}

async function steps(smoke: Smoke, choice: ProfileChoice): Promise<number> {
  introduced(smoke)
  const serve = await command(smoke, ['serve', '--json'])
  tell(`serve exited ${serve.code}`)
  if (serve.code !== 0 || !(await profileAdded(smoke, choice))) {
    return exitOf(smoke, [1])
  }
  const first = await firstRun(smoke)
  const second = smoke.stopping.received ? first : await resumePath(smoke)
  return exitOf(smoke, [first, second])
}

const flagsOf = (plan: SmokePlan, choice: ProfileChoice): readonly string[] => [
  '--provider',
  plan.provider,
  ...(choice.kind === 'login' ? ['--profile', choice.id] : []),
]

// The steps on a throwaway home, whose daemon is stopped and which is removed whatever happens
async function onThrowaway(plan: SmokePlan, choice: ProfileChoice): Promise<number> {
  const smoke: Smoke = { ...throwaway(), plan, flags: flagsOf(plan, choice) }
  const release = heldSignals(smoke)
  try {
    prepare(smoke)
    return await steps(smoke, choice)
  } finally {
    await cleanedUp(smoke)
    release()
  }
}

// A run to its end, then a stop, resume and prompt of a second session
export async function runSmoke(plan: SmokePlan): Promise<number> {
  const choice = profileChoiceOf(plan)
  if (choice.kind === 'refused') {
    tell(choice.reason)
    return 1
  }
  const code = await onThrowaway(plan, choice)
  return code
}
