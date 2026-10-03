import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AgentSession, AskAnswer, CreateSessionRequest } from '@bytebureau/plugin-api'
import type { AgentEvent, PromptInput, Usage } from '@bytebureau/protocol'
import { EventQueue } from './event-queue.js'
import { exportQuestion } from './fake-ask.js'

export type Script = 'hello' | 'slow'

const SLOW_MS = 10_000
const NAMED_EXPORT = "export function hello(): string {\n  return 'hello'\n}\n"
const DEFAULT_EXPORT = "export default function hello(): string {\n  return 'hello'\n}\n"
const HELLO_USAGE: Usage = { inputTokens: 120, outputTokens: 40, costUsd: 0.002, contextPct: 3 }
const SLOW_USAGE: Usage = { inputTokens: 1, outputTokens: 1 }
const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 }

// Named unless the human picked the default export or wrote an answer of their own
const wantsNamedExport = (answer: AskAnswer): boolean =>
  answer.selected !== 'other' && answer.selected[0] !== 'default'

// A scripted agent: it works in the workspace and reports what it does through its event queue
// The hello script writes src/hello.ts after one question; the slow script runs until it is interrupted or ten seconds are over
export class FakeSession implements AgentSession {
  public readonly externalRef = null
  private readonly queue = new EventQueue()
  private readonly request: CreateSessionRequest
  private readonly script: Script
  // What a script is parked on, the answer of a human or the clock; interrupt and close wake it up
  private awaitedAnswer: ((answer: AskAnswer | null) => void) | null = null
  private awaitedClock: (() => void) | null = null
  private turnRunning = false
  private closed = false

  public constructor(request: CreateSessionRequest, script: Script) {
    this.request = request
    this.script = script
  }

  // A prompt that comes after the session was closed is not run, so no timer or file is left behind
  public async prompt(input: PromptInput): Promise<void> {
    if (!this.closed) {
      this.turnRunning = true
      await (this.script === 'slow' ? this.runSlow() : this.runHello(input))
    }
  }

  public async interrupt(): Promise<void> {
    this.wake()
    this.endTurn('interrupted', NO_USAGE)
    await Promise.resolve()
  }

  public async answer(_askId: string, answer: AskAnswer): Promise<void> {
    const waiting = this.awaitedAnswer
    this.awaitedAnswer = null
    if (waiting !== null) {
      waiting(answer)
    }
    await Promise.resolve()
  }

  public events(): AsyncIterable<AgentEvent> {
    return this.queue
  }

  public async close(): Promise<void> {
    this.closed = true
    this.wake()
    this.turnRunning = false
    this.queue.end()
    await Promise.resolve()
  }

  // Lets a parked script go on: without an answer, and without waiting for the clock
  private wake(): void {
    const answer = this.awaitedAnswer
    const clock = this.awaitedClock
    this.awaitedAnswer = null
    this.awaitedClock = null
    if (answer !== null) {
      answer(null)
    }
    if (clock !== null) {
      clock()
    }
  }

  // A turn ends once, with the first reason that comes
  private endTurn(stopReason: string, usage: Usage): void {
    if (this.turnRunning) {
      this.turnRunning = false
      this.queue.push({ type: 'turn.completed', stopReason, usage })
    }
  }

  private async runSlow(): Promise<void> {
    this.queue.push({ type: 'turn.started' })
    const { promise, resolve } = Promise.withResolvers<null>()
    const timer = setTimeout(() => {
      this.awaitedClock = null
      this.endTurn('end_turn', SLOW_USAGE)
      resolve(null)
    }, SLOW_MS)
    this.awaitedClock = (): void => {
      clearTimeout(timer)
      resolve(null)
    }
    await promise
  }

  private async runHello(input: PromptInput): Promise<void> {
    const target = path.join(this.request.workspace.path, 'src', 'hello.ts')
    this.beginHello(target)
    const answer = await this.ask()
    if (answer !== null) {
      this.finishHello(target, input, wantsNamedExport(answer) ? NAMED_EXPORT : DEFAULT_EXPORT)
    }
  }

  private beginHello(target: string): void {
    this.queue.push(
      { type: 'turn.started' },
      { type: 'message.delta', kind: 'text', text: 'Creating src/hello.ts' },
      {
        type: 'tool.started',
        id: 'tool-1',
        name: 'Write',
        kind: 'builtin',
        input: { path: 'src/hello.ts' },
      },
    )
    mkdirSync(path.dirname(target), { recursive: true })
  }

  // The question is announced once the script waits for it, so an answer cannot come early
  private async ask(): Promise<AskAnswer | null> {
    const { promise, resolve } = Promise.withResolvers<AskAnswer | null>()
    this.awaitedAnswer = resolve
    this.queue.push({ type: 'ask.requested', ask: exportQuestion(this.request.sessionId) })
    const answer = await promise
    return answer
  }

  private finishHello(target: string, input: PromptInput, content: string): void {
    writeFileSync(target, content)
    this.queue.push(
      {
        type: 'tool.completed',
        id: 'tool-1',
        outputSummary: 'wrote src/hello.ts',
        bytes: Buffer.byteLength(content),
      },
      {
        type: 'message.completed',
        role: 'assistant',
        content: [
          { type: 'text', text: `Done: ${input.text.length} characters of instructions handled.` },
        ],
        text: 'Created src/hello.ts exporting hello().',
      },
      { type: 'usage.updated', usage: HELLO_USAGE },
    )
    this.endTurn('end_turn', HELLO_USAGE)
  }
}
