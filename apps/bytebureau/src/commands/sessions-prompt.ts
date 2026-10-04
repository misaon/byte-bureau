import { defineCommand } from 'citty'
import type { Bureau } from '../bureau/bureau.js'
import { bureauFlags, globalArgs, processContext, type Context } from '../context.js'
import { describeError } from '../errors.js'
import { withBureauRefusable } from './refusable.js'
import { conclude, promptAndFollow, type Ends } from './run-follow.js'
import { closeFrame, open, refuse } from './run-output.js'
import { isRefusal } from './run-session.js'

// A prompt ends with its turn, or with the session if that ends first; the session stays ready for the next prompt
// An interrupted turn ends where the session says what became of it: ready again, stopped or errored
const PROMPT_ENDS: Ends = {
  terminal: new Set(['turn.completed', 'session.stopped', 'session.errored']),
  completes: false,
  turnOnly: true,
}

export interface PromptOptions {
  readonly id: string
  readonly text: string
  readonly yes: boolean
}

async function followPrompt(
  bureau: Bureau,
  options: PromptOptions,
  context: Context,
): Promise<number> {
  const run = { bureau, session: { id: options.id }, context, yes: options.yes, ends: PROMPT_ENDS }
  const followed = await promptAndFollow(run, options.text)
  return conclude(followed, context)
}

// Prompts a session and follows the new turn to its end; the exit code is 0 completed, 3 interrupted or stopped, 4 errored, or refused as a run is (worktree, provider)
// Any other failure closes the frame and goes on; the command tells it if it is a refusal
export async function promptSession(
  bureau: Bureau,
  options: PromptOptions,
  context: Context,
): Promise<number> {
  open(context, options.text)
  try {
    return await followPrompt(bureau, options, context)
  } catch (error) {
    if (!isRefusal(error)) {
      closeFrame(context)
      throw error
    }
    return refuse(context, describeError(error))
  }
}

export const promptCommand = defineCommand({
  meta: { name: 'prompt', description: 'Prompt a session and follow its turn to the end' },
  args: {
    ...globalArgs,
    id: { type: 'positional', description: 'Session id', required: true },
    text: { type: 'positional', description: 'The prompt', required: true },
  },
  async run({ args }) {
    const context = processContext(args)
    const options = { id: args.id, text: args.text, yes: args.yes }
    const code = await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
      const ended = await promptSession(bureau, options, context)
      return ended
    })
    if (code !== undefined) {
      process.exitCode = code
    }
  },
})
