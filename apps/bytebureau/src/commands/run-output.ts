import { m } from '@bytebureau/i18n'
import type { EventEnvelope } from '@bytebureau/protocol'
import { intro, log, outro } from '@clack/prompts'
import type { Context } from '../context.js'
import { titleOf, transcriptLine } from '../render/transcript.js'

export const EXIT_REFUSED = 4

// How a run ended: its exit code and the closing words
export interface Outcome {
  readonly code: number
  readonly text: string
}

// A refusal is told in one line, whatever the text behind it, such as the stderr of git, spans
export function oneLine(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('; ')
}

// A terminal gets a frame: the session opens it, and every way out of the run closes it
export function open({ output, interactive }: Context, prompt: string): void {
  if (interactive) {
    const title = titleOf(prompt)
    intro(output.colors.bold(m.run_intro({ title })))
  }
}

export function closeFrame({ interactive }: Context): void {
  if (interactive) {
    outro()
  }
}

// A refusal ends the run with exit code 4: its text is the closing line of the frame, or goes to stderr
export function refuse({ output, interactive }: Context, text: string): number {
  if (interactive) {
    outro(oneLine(text))
  } else {
    output.warn(oneLine(text))
  }
  return EXIT_REFUSED
}

// JSON output is the events themselves; text output the lines worth reading, decorated at a terminal
export function show(event: EventEnvelope, { output, interactive }: Context): void {
  if (output.json) {
    output.emit(event)
    return
  }
  const line = transcriptLine(event, output)
  if (line === undefined) {
    return
  }
  if (interactive) {
    log.message(line)
  } else {
    output.print(line)
  }
}

export function report({ code, text }: Outcome, { output, interactive }: Context): void {
  if (interactive) {
    outro(text)
  } else if (code === EXIT_REFUSED) {
    output.warn(text)
  } else {
    output.print(text)
  }
}
