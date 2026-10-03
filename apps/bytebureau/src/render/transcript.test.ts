import { setLocale } from '@bytebureau/i18n'
import type { EventEnvelope, KernelEventPayload } from '@bytebureau/protocol'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createOutput } from '../output.js'
import { event } from '../testing/events.js'
import { completionLine, summarizeRun, titleOf, transcriptLine } from './transcript.js'

const ESCAPE = '\u001B'

const PLAIN = createOutput({ json: false, color: false })
const COLOURED = createOutput({ json: false, color: true })

function toolStarted(input: unknown): EventEnvelope {
  return event('tool.started', { id: 't1', name: 'Write', kind: 'builtin', input })
}

describe(transcriptLine, () => {
  it('renders assistant text, tool starts and ask requests; ignores deltas', () => {
    expect(
      transcriptLine(event('message.assistant.completed', { text: 'Hello', content: [] }), PLAIN),
    ).toBe('Hello')
    expect(transcriptLine(toolStarted({ path: 'src/hello.ts' }), PLAIN)).toBe(
      '⚙ Write src/hello.ts',
    )
    expect(
      transcriptLine(event('message.assistant.delta', { kind: 'text', text: 'H' }), PLAIN),
    ).toBeUndefined()
  })

  it('prints nothing for an assistant message without text', () => {
    expect(
      transcriptLine(event('message.assistant.completed', { text: '', content: [] }), PLAIN),
    ).toBeUndefined()
  })

  it('prints nothing for events that are not part of the story', () => {
    const usage = { inputTokens: 1, outputTokens: 1 }
    expect(transcriptLine(event('session.ready', { status: 'ready' }), PLAIN)).toBeUndefined()
    expect(transcriptLine(event('usage.updated', { usage }), PLAIN)).toBeUndefined()
  })

  it('colours a failure red and leaves plain output free of escape codes', () => {
    const failed = event('tool.failed', { id: 't1', name: 'Bash', error: 'exit 1' })
    expect(transcriptLine(failed, COLOURED)).toContain(ESCAPE)
    expect(transcriptLine(failed, PLAIN)).not.toContain(ESCAPE)
  })
})

describe('transcriptLine for tools', () => {
  it('shows the path, the command or the pattern of a tool, whichever its input has', () => {
    expect(transcriptLine(toolStarted({ command: 'bun test' }), PLAIN)).toBe('⚙ Write bun test')
    expect(transcriptLine(toolStarted({ pattern: '*.ts' }), PLAIN)).toBe('⚙ Write *.ts')
    expect(transcriptLine(toolStarted({ path: 7, command: 'ls' }), PLAIN)).toBe('⚙ Write ls')
  })

  it('shows just the name of a tool whose input names no target', () => {
    // A JSON null reaches the renderer as it came off the wire
    const wireNull: unknown = JSON.parse('null')
    expect(transcriptLine(toolStarted({ depth: 2 }), PLAIN)).toBe('⚙ Write')
    expect(transcriptLine(toolStarted('text'), PLAIN)).toBe('⚙ Write')
    expect(transcriptLine(toolStarted(wireNull), PLAIN)).toBe('⚙ Write')
  })

  it('renders a failed tool', () => {
    const failed = event('tool.failed', { id: 't1', name: 'Bash', error: 'exit 1' })
    expect(transcriptLine(failed, PLAIN)).toBe('✖ Bash: exit 1')
  })
})

describe('transcriptLine for the life of a session', () => {
  it('renders a warning and the start of a turn', () => {
    const warning = event('session.warning', { kind: 'limit', message: 'near the limit' })
    const started = event('turn.started', { turnId: 'u1', index: 0, status: 'running' })
    expect(transcriptLine(warning, PLAIN)).toBe('! near the limit')
    expect(transcriptLine(started, PLAIN)).toBe('The employee is working…')
  })

  it('names the branch of a provisioned workspace', () => {
    const provisioned = event('workspace.provisioned', {
      path: '/repo/.bytebureau/worktrees/s1',
      branch: 'bb/hello',
      baseRef: 'main',
      runtimeId: 'local',
    })
    expect(transcriptLine(provisioned, PLAIN)).toBe('Preparing the workspace on branch bb/hello')
  })

  it('speaks the language that is set', () => {
    onTestFinished(() => {
      setLocale('en')
    })
    setLocale('cs')
    const started = event('turn.started', { turnId: 'u1', index: 0, status: 'running' })
    expect(transcriptLine(started, PLAIN)).toBe('Zaměstnanec pracuje…')
  })
})

function turnCompleted(
  usage: KernelEventPayload<'turn.completed'>['usage'],
  seq: number,
): EventEnvelope {
  return event(
    'turn.completed',
    { turnId: `u${seq}`, index: seq, status: 'completed', stopReason: 'end_turn', usage },
    seq,
  )
}

describe(summarizeRun, () => {
  it('counts turns and tokens from turn.completed events', () => {
    const events = [
      turnCompleted({ inputTokens: 10, outputTokens: 5, costUsd: 0.01 }, 1),
      turnCompleted({ inputTokens: 1, outputTokens: 1 }, 2),
    ]
    expect(summarizeRun(events)).toStrictEqual({
      turns: 2,
      inputTokens: 11,
      outputTokens: 6,
      costUsd: 0.01,
    })
  })

  it('adds up the cost of the turns that report one and ignores other events', () => {
    const events = [
      turnCompleted({ inputTokens: 1, outputTokens: 1, costUsd: 0.25 }, 1),
      event('session.ready', { status: 'ready' }, 2),
      turnCompleted({ inputTokens: 1, outputTokens: 1, costUsd: 0.5 }, 3),
    ]
    expect(summarizeRun(events).costUsd).toBe(0.75)
  })

  it('reports no cost for a run whose turns reported none, and nothing for no turns', () => {
    expect(
      summarizeRun([turnCompleted({ inputTokens: 1, outputTokens: 1 }, 1)]).costUsd,
    ).toBeUndefined()
    expect(summarizeRun([])).toStrictEqual({
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: undefined,
    })
  })
})

describe(completionLine, () => {
  it('states turns and tokens, with the cost when there is one', () => {
    expect(completionLine({ turns: 1, inputTokens: 120, outputTokens: 40, costUsd: 0.016 })).toBe(
      'Done in 1 turn(s), 120 input and 40 output tokens ($0.02)',
    )
    expect(completionLine({ turns: 2, inputTokens: 3, outputTokens: 4 })).toBe(
      'Done in 2 turn(s), 3 input and 4 output tokens',
    )
  })
})

describe(titleOf, () => {
  it('keeps a short prompt as it is', () => {
    expect(titleOf('Create src/hello.ts exporting hello()')).toBe(
      'Create src/hello.ts exporting hello()',
    )
  })

  it('takes the first line of a prompt that has several, whatever its line endings', () => {
    expect(titleOf('Fix the build\n\nIt fails on CI')).toBe('Fix the build')
    expect(titleOf('Fix the build\r\nIt fails on CI')).toBe('Fix the build')
    expect(titleOf('\n  Fix the build  \n')).toBe('Fix the build')
  })

  it('cuts at sixty characters without splitting an emoji or a diacritic', () => {
    const emoji = `${'a'.repeat(59)}😀 and more`
    expect(titleOf(emoji)).toBe(`${'a'.repeat(59)}😀`)
    expect(titleOf('Příliš žluťoučký kůň úpěl ďábelské ódy a pokračuje dál a dál do noci')).toBe(
      'Příliš žluťoučký kůň úpěl ďábelské ódy a pokračuje dál a dál',
    )
  })

  it('is empty for an empty prompt', () => {
    expect(titleOf('')).toBe('')
    expect(titleOf('  \n ')).toBe('')
  })
})
