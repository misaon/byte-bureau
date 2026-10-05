import { ApiError } from '@bytebureau/client'
import { m } from '@bytebureau/i18n'
import { ProfileError, ProviderError, SessionError, WorkspaceError } from '@bytebureau/kernel'
import type { CreateSessionBody } from '@bytebureau/protocol'
import type { Bureau } from '../bureau/bureau.js'
import type { Context } from '../context.js'
import { describeError } from '../errors.js'
import { titleOf } from '../render/transcript.js'
import { conclude, promptAndFollow, type Ends } from './run-follow.js'
import { closeFrame, open, refuse } from './run-output.js'

// A run is one turn: its end is the end of its session, which the CLI completes once the turn is over
// A turn that is interrupted ends the run where the session says what became of it: ready again, stopped or errored
const RUN_ENDS: Ends = {
  terminal: new Set(['session.completed', 'session.stopped', 'session.errored']),
  completes: true,
  turnOnly: false,
}

// Through the daemon a refusal of the kernel comes as a problem with the code the API gives its error
const REMOTE_REFUSALS = /^(?:workspace_|provider_|profile_|session_provider_missing$)/u

export interface RunOptions {
  readonly prompt: string
  // An absolute path: the daemon would resolve a relative one in its own working directory
  readonly project: string
  readonly branch?: string | undefined
  readonly employee?: string | undefined
  readonly provider?: string | undefined
  // A profile of the provider; the kernel takes the provider's default where none is named
  readonly profile?: string | undefined
  // The BYTEBUREAU_* variables of the command, for the agent: a daemon does not read the environment of the command
  readonly env: Readonly<Record<string, string>>
  readonly yes: boolean
}

// Failures that end a run with exit code 4: a project, a runtime or a worktree that cannot be used, a provider or a profile that is missing or fails
export function isRefusal(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.problem !== undefined && REMOTE_REFUSALS.test(error.problem.code)
  }
  if (error instanceof WorkspaceError || error instanceof ProfileError) {
    return true
  }
  if (error instanceof SessionError) {
    return error.code === 'provider_missing'
  }
  return error instanceof ProviderError
}

// A named provider is checked before anything is registered or created
async function unknownProvider(
  bureau: Bureau,
  provider: string | undefined,
): Promise<string | undefined> {
  if (provider === undefined) {
    return undefined
  }
  const providers = await bureau.plugins.providers()
  const available = providers.map((candidate) => candidate.id)
  return available.includes(provider)
    ? undefined
    : m.run_provider_missing({ provider, available: available.join(', ') })
}

// The session as the person asked for it: what is not named is left to the kernel
function sessionBody(projectId: string, options: RunOptions): CreateSessionBody {
  return {
    projectId,
    title: titleOf(options.prompt),
    ...(options.employee === undefined ? {} : { employeeId: options.employee }),
    ...(options.provider === undefined ? {} : { providerId: options.provider }),
    ...(options.profile === undefined ? {} : { profileId: options.profile }),
    ...(options.branch === undefined ? {} : { branch: options.branch }),
    env: options.env,
  }
}

async function startAndFollow(
  bureau: Bureau,
  options: RunOptions,
  context: Context,
): Promise<number> {
  const project = await bureau.projects.register(options.project)
  const session = await bureau.sessions.create(sessionBody(project.id, options))
  const run = { bureau, session, context, yes: options.yes, ends: RUN_ENDS }
  const followed = await promptAndFollow(run, options.prompt)
  return conclude(followed, context)
}

// A named provider is refused before anything is registered or created
async function runOrRefuse(bureau: Bureau, options: RunOptions, context: Context): Promise<number> {
  const refusal = await unknownProvider(bureau, options.provider)
  if (refusal !== undefined) {
    return refuse(context, refusal)
  }
  const code = await startAndFollow(bureau, options, context)
  return code
}

// Streams one session to its end; the exit code is 0 completed, 3 stopped, 4 project, worktree or provider refused
// A failure that has no exit code of its own closes the frame and goes on to the runner
export async function runSession(
  bureau: Bureau,
  options: RunOptions,
  context: Context,
): Promise<number> {
  open(context, options.prompt)
  try {
    return await runOrRefuse(bureau, options, context)
  } catch (error) {
    if (!isRefusal(error)) {
      closeFrame(context)
      throw error
    }
    return refuse(context, describeError(error))
  }
}
