import type { ChildProcess } from 'node:child_process'
import type { Exit } from './process.js'
import { withinLimit } from './within-limit.js'

const STEP_MS = 5000

// The pids 0 and 1 would address the caller's own group and every process; a group that is gone is no error
const signalGroup = (pid: number | undefined, signal: NodeJS.Signals): boolean => {
  if (pid === undefined || pid <= 1) {
    return false
  }
  try {
    return process.kill(-pid, signal)
  } catch {
    return false
  }
}

// What the agent started dies with it; without a group of its own, the agent alone is signalled
const signal = (child: ChildProcess, name: NodeJS.Signals): void => {
  if (!signalGroup(child.pid, name)) {
    child.kill(name)
  }
}

// Whatever of the agent's group outlived it is killed, as nothing is left to wait for
export const sweepGroup = (child: ChildProcess): void => {
  signalGroup(child.pid, 'SIGKILL')
}

// A signal for an agent that still runs, then as long as one step for it to end
const step = async (
  child: ChildProcess,
  exited: Promise<Exit>,
  { name, stepMs }: { readonly name: NodeJS.Signals; readonly stepMs: number },
): Promise<Exit | null> => {
  if (child.exitCode === null && child.signalCode === null) {
    signal(child, name)
  }
  const exit = await withinLimit(exited, stepMs)
  return exit
}

const ladder = async (
  child: ChildProcess,
  exited: Promise<Exit>,
  stepMs: number,
): Promise<Exit | null> => {
  const interrupted = await step(child, exited, { name: 'SIGINT', stepMs })
  if (interrupted !== null) {
    return interrupted
  }
  const terminated = await step(child, exited, { name: 'SIGTERM', stepMs })
  if (terminated !== null) {
    return terminated
  }
  const killed = await step(child, exited, { name: 'SIGKILL', stepMs })
  return killed
}

// SIGINT, five seconds, SIGTERM, five seconds, SIGKILL, each to the agent's process group: the exit of the agent, or null when even SIGKILL did not end it in time
export const endProcess = async (
  child: ChildProcess,
  exited: Promise<Exit>,
  stepMs = STEP_MS,
): Promise<Exit | null> => {
  const exit = await ladder(child, exited, stepMs)
  sweepGroup(child)
  return exit
}
