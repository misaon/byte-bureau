import { ApiError } from '@bytebureau/client'
import {
  AskError,
  ConfigError,
  ProviderError,
  SessionError,
  WorkspaceError,
} from '@bytebureau/kernel'
import type { Bureau } from '../bureau/bureau.js'
import type { BureauFlags } from '../bureau/resolve.js'
import { withBureau } from '../bureau/with-bureau.js'
import type { Context } from '../context.js'
import { oneLine } from './run-output.js'

// What a refusal says: the detail of the problem the daemon answered with, or the reason of the kernel's own error
// The errors of the kernel that the API answers with a 4xx problem are the refusals in-process, told as the API tells them
// A failure that is no refusal has none
function refusalOf(error: unknown): string | undefined {
  if (error instanceof ApiError) {
    const { problem } = error
    return problem !== undefined && error.status < 500 ? problem.detail : undefined
  }
  if (error instanceof ConfigError) {
    return `${error.file}${error.pointer}: ${error.reason}`
  }
  if (error instanceof ProviderError) {
    return error.kind === 'missing' ? error.reason : undefined
  }
  if (
    error instanceof SessionError ||
    error instanceof AskError ||
    error instanceof WorkspaceError
  ) {
    return error.reason
  }
  return undefined
}

// A request that is refused, by the daemon with a 4xx problem or by the kernel in-process, ends the command with exit code 1 and its reason in one line
// Any other failure goes on to the runner; nothing comes back for a refusal, so the command prints no success
export async function refusable<Result>(
  context: Context,
  work: () => Promise<Result>,
): Promise<Result | undefined> {
  try {
    const result = await work()
    return result
  } catch (error) {
    const refusal = refusalOf(error)
    if (refusal === undefined) {
      throw error
    }
    context.output.warn(oneLine(refusal))
    process.exitCode = 1
    return undefined
  }
}

// The work of a command with its Bureau, refusable: what it came to, or nothing once a refusal has ended the command
export async function withBureauRefusable<Result>(
  context: Context,
  flags: BureauFlags,
  work: (bureau: Bureau) => Promise<Result>,
): Promise<Result | undefined> {
  const result = await refusable(context, async () => {
    const done = await withBureau(context, flags, work)
    return done
  })
  return result
}
