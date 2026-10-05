import type { ChildProcess } from 'node:child_process'
import type { Exit } from './process.js'
import { withinLimit } from './within-limit.js'

const STEP_MS = 5000

// A signal for an agent that still runs, then as long as one step for it to end
const step = async (
  child: ChildProcess,
  exited: Promise<Exit>,
  { signal, stepMs }: { readonly signal: NodeJS.Signals; readonly stepMs: number },
): Promise<Exit | null> => {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal)
  }
  const exit = await withinLimit(exited, stepMs)
  return exit
}

// SIGINT, five seconds, SIGTERM, five seconds, SIGKILL: the exit of the agent, or null when even SIGKILL did not end it in time
export const endProcess = async (
  child: ChildProcess,
  exited: Promise<Exit>,
  stepMs = STEP_MS,
): Promise<Exit | null> => {
  const interrupted = await step(child, exited, { signal: 'SIGINT', stepMs })
  if (interrupted !== null) {
    return interrupted
  }
  const terminated = await step(child, exited, { signal: 'SIGTERM', stepMs })
  if (terminated !== null) {
    return terminated
  }
  const killed = await step(child, exited, { signal: 'SIGKILL', stepMs })
  return killed
}
