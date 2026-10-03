import { m } from '@bytebureau/i18n'
import {
  decodeEventPayload,
  EventPayloadError,
  type EventEnvelope,
  type KernelEventPayload,
} from '@bytebureau/protocol'
import type { Output } from '../output.js'

export interface RunSummary {
  readonly turns: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd?: number | undefined
}

const TITLE_LENGTH = 60
const CHARACTERS = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// The first line of the prompt, cut at 60 characters; an emoji or an accented letter is never split
export function titleOf(prompt: string): string {
  const [firstLine = ''] = prompt.trim().split(/\r?\n/u)
  const characters = Array.from(CHARACTERS.segment(firstLine), ({ segment }) => segment)
  return characters.slice(0, TITLE_LENGTH).join('')
}

const TARGET_KEYS = ['path', 'command', 'pattern'] as const

// The one field of a tool input worth a glance: the path, the command or the pattern
function toolTarget(input: unknown): string {
  if (typeof input !== 'object' || input === null) {
    return ''
  }
  for (const key of TARGET_KEYS) {
    const target: unknown = Reflect.get(input, key)
    if (typeof target === 'string') {
      return ` ${target}`
    }
  }
  return ''
}

function toolStartLine(payload: KernelEventPayload<'tool.started'>, output: Output): string {
  return output.colors.dim(`⚙ ${m.run_tool({ name: payload.name })}${toolTarget(payload.input)}`)
}

function toolFailLine(payload: KernelEventPayload<'tool.failed'>, output: Output): string {
  return output.colors.red(`✖ ${payload.name}: ${payload.error}`)
}

function assistantLine(text: string): string | undefined {
  return text === '' ? undefined : text
}

// An event whose payload does not fit its type is skipped, with one warning that names it; any other failure is not the event's
export function readOrSkip<Result>(
  event: EventEnvelope,
  output: Output,
  read: () => Result,
): Result | undefined {
  try {
    return read()
  } catch (error) {
    if (!(error instanceof EventPayloadError)) {
      throw error
    }
    output.warn(m.run_event_skipped({ type: event.type, seq: event.seq }))
    return undefined
  }
}

function lineOf(event: EventEnvelope, output: Output): string | undefined {
  switch (event.type) {
    case 'message.assistant.completed': {
      return assistantLine(decodeEventPayload(event.type, event.payload).text)
    }
    case 'tool.started': {
      return toolStartLine(decodeEventPayload(event.type, event.payload), output)
    }
    case 'tool.failed': {
      return toolFailLine(decodeEventPayload(event.type, event.payload), output)
    }
    case 'session.warning': {
      return output.colors.yellow(`! ${decodeEventPayload(event.type, event.payload).message}`)
    }
    case 'workspace.provisioned': {
      const { branch } = decodeEventPayload(event.type, event.payload)
      return output.colors.dim(m.run_provisioning({ branch }))
    }
    case 'turn.started': {
      return output.colors.dim(m.run_turn_started())
    }
    default: {
      return undefined
    }
  }
}

// One printable line per durable event the user cares about; undefined means "print nothing"
export function transcriptLine(event: EventEnvelope, output: Output): string | undefined {
  return readOrSkip(event, output, () => lineOf(event, output))
}

const NO_TURNS: RunSummary = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: undefined }

function withTurn(
  summary: RunSummary,
  usage: KernelEventPayload<'turn.completed'>['usage'],
): RunSummary {
  return {
    turns: summary.turns + 1,
    inputTokens: summary.inputTokens + usage.inputTokens,
    outputTokens: summary.outputTokens + usage.outputTokens,
    costUsd: usage.costUsd === undefined ? summary.costUsd : (summary.costUsd ?? 0) + usage.costUsd,
  }
}

// A turn that cannot be read is not counted
function withEventTurn(summary: RunSummary, event: EventEnvelope, output: Output): RunSummary {
  const turn = readOrSkip(event, output, () => decodeEventPayload('turn.completed', event.payload))
  return turn === undefined ? summary : withTurn(summary, turn.usage)
}

export function summarizeRun(events: readonly EventEnvelope[], output: Output): RunSummary {
  let summary = NO_TURNS
  for (const event of events) {
    if (event.type === 'turn.completed') {
      summary = withEventTurn(summary, event, output)
    }
  }
  return summary
}

// Under a cent the cost gets four decimals, since it would read as nothing at two
function costText(costUsd: number): string {
  return ` ($${costUsd.toFixed(costUsd < 0.01 ? 4 : 2)})`
}

// The closing line of a run that completed: turns, tokens and, when the provider reports it, the cost
export function completionLine(summary: RunSummary): string {
  return m.run_completed({
    turns: summary.turns,
    input: summary.inputTokens,
    output: summary.outputTokens,
    cost: summary.costUsd === undefined ? '' : costText(summary.costUsd),
  })
}
