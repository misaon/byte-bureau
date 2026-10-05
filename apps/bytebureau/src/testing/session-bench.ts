import { setTimeout as sleep } from 'node:timers/promises'
import { startDaemonProcess, type DaemonProcess } from './daemon.js'
import { firstField, firstId, jsonLines, listedUnder } from './json-lines.js'
import { runCli, type CliResult } from './run-cli.js'
import { NO_DAEMON, ON_FAKE, PROMPT, SCRIPTED, sessionIdIn, workbench } from './workbench.js'

export const MISSING = '0192f0a0-0000-7000-8000-000000000009'

// The agent of the fake provider waits on its ask, which the stop of a run leaves unanswered
export const WAITING = '"type":"session.waiting"'

export type Env = Readonly<Record<string, string>>

// The exit code and the line of stderr of a command that is refused
export async function refusal(
  args: readonly string[],
  env: Env,
): Promise<readonly [number, string]> {
  const result = await runCli(args, env)
  return [result.code, result.stderr.trim()]
}

// The turns that the events a command printed belong to
export function turnsOf(stdout: string): readonly unknown[] {
  const turns = jsonLines(stdout)
    .map((record) => record['turnId'])
    .filter((turnId) => turnId !== undefined)
  return [...new Set(turns)]
}

// A daemon for the home of a test, which the test ends gracefully, and a repository to run on
export interface Bench {
  readonly repo: string
  readonly home: string
  readonly env: Env
  readonly daemon: DaemonProcess
}

export type Session = Bench & { readonly id: string }

export async function benchWithDaemon(variables: Env = {}): Promise<Bench> {
  const { repo, home } = workbench()
  const daemon = await startDaemonProcess(home)
  return { repo, home, env: { BYTEBUREAU_HOME: home, ...variables }, daemon }
}

// A run of the fake agent to its end: a completed session
export async function completedSession(): Promise<Session> {
  const bench = await benchWithDaemon()
  await runCli(['run', PROMPT, '--project', bench.repo, ...SCRIPTED], bench.env)
  const id = await sessionIdIn(bench.home, [])
  return { ...bench, id }
}

// A run that its signal stops once it has printed the text: a stopped session, and what the run printed
export async function stoppedSession(
  variables: Env,
  afterStdout: string,
): Promise<Session & { readonly first: CliResult }> {
  const bench = await benchWithDaemon(variables)
  const run = ['run', PROMPT, '--project', bench.repo, ...ON_FAKE, '--json']
  const first = await runCli(run, bench.env, { signal: 'SIGTERM', afterStdout })
  const id = await sessionIdIn(bench.home, [])
  return { ...bench, id, first }
}

export async function resumedSession(): Promise<Session & { readonly first: CliResult }> {
  const stopped = await stoppedSession({}, WAITING)
  await runCli(['sessions', 'resume', stopped.id], stopped.env)
  return stopped
}

// What `sessions show` tells once the session is in the status; the last look when the deadline passes first
export async function untilStatus(
  session: Pick<Session, 'env' | 'id'>,
  status: string,
  deadline = Date.now() + 5000,
): Promise<CliResult> {
  const shown = await runCli(['sessions', 'show', session.id], session.env)
  if (new RegExp(`^status\\s+${status}$`, 'mu').test(shown.stdout) || Date.now() >= deadline) {
    return shown
  }
  await sleep(100)
  return untilStatus(session, status, deadline)
}

// The kernel announces the end of a turn a moment before the session is ready for the next prompt
export async function ready(session: Session): Promise<CliResult> {
  const shown = await untilStatus(session, 'ready')
  return shown
}

// What a turn of the slow script prints once it works, which it does until it is stopped
export const WORKING = '"type":"turn.started"'

// A session of the slow script that was stopped while it worked, and is resumed; the script is kept across the stop
export async function resumedSlowSession(): Promise<Session> {
  const session = await stoppedSession({ BYTEBUREAU_FAKE_SCRIPT: 'slow' }, WORKING)
  await runCli(['sessions', 'resume', session.id], session.env)
  return session
}

// A turn of the slow script that a prompt follows, once the session is at work on it
export async function slowTurn(): Promise<Session & { readonly prompting: Promise<CliResult> }> {
  const session = await resumedSlowSession()
  const prompting = runCli(['sessions', 'prompt', session.id, 'go on', '--json'], session.env)
  await untilStatus(session, 'running')
  return { ...session, prompting }
}

// A prompt, once the session is ready for it, followed to the end of its turn
export async function promptedAgain(session: Session, text: string): Promise<CliResult> {
  await ready(session)
  const prompted = await runCli(
    ['sessions', 'prompt', session.id, text, '--json', '--yes'],
    session.env,
  )
  return prompted
}

// A run in the process of the command that its signal stops while the agent waits on its ask
export async function stoppedInProcess(): Promise<{ readonly env: Env; readonly id: string }> {
  const { repo, home } = workbench()
  const env = { BYTEBUREAU_HOME: home }
  const run = ['run', PROMPT, '--project', repo, ...ON_FAKE, '--json', NO_DAEMON]
  await runCli(run, env, { signal: 'SIGTERM', afterStdout: WAITING })
  const id = await sessionIdIn(home)
  return { env, id }
}

// The stdout of `ask ls --json` once an ask waits; the last one when the deadline passes first
export async function asksWaiting(env: Env, deadline: number): Promise<string> {
  const listed = await runCli(['ask', 'ls', '--json'], env)
  if (listedUnder(listed.stdout, 'asks').length > 0 || Date.now() >= deadline) {
    return listed.stdout
  }
  await sleep(200)
  return asksWaiting(env, deadline)
}

// A run that waits on the ask of the fake agent: off a terminal and without --yes it leaves the ask to another command
export interface Waiting {
  readonly env: Env
  readonly daemon: DaemonProcess
  readonly run: Promise<CliResult>
  // What `ask ls --json` told once the ask was there
  readonly listed: string
  // The ask it waits on, and the session it belongs to
  readonly id: string
  readonly sessionId: string
}

// The output of the run is its events as JSON lines unless the flags say otherwise
export async function waitingRun(output: readonly string[] = ['--json']): Promise<Waiting> {
  const { repo, env, daemon } = await benchWithDaemon()
  const run = runCli(['run', PROMPT, '--project', repo, ...ON_FAKE, ...output], env)
  const listed = await asksWaiting(env, Date.now() + 15_000)
  const sessionId = firstField(listed, 'asks', 'sessionId')
  return { env, daemon, run, listed, id: firstId(listed, 'asks'), sessionId }
}

// The ask is answered with --yes, and the run goes on to its end
export async function finished({ env, run, id }: Waiting): Promise<CliResult> {
  await runCli(['ask', 'answer', id, '--yes'], env)
  const result = await run
  return result
}
