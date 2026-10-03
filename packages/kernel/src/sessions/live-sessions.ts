import type { AgentSession } from '@bytebureau/plugin-api'
import { Semaphore, type Effect, type Fiber } from 'effect'
import type { TurnRef } from './translate.js'
import type { Session } from './types.js'

// A tool call the provider has started: the row that records it and the name its end is told by
interface ToolNote {
  readonly rowId: string
  readonly name: string
}

// A provider session that is attached: what the pump of its events needs to know
export interface Live {
  // The session as it was when the provider session started; only what never changes is read from it
  readonly session: Session
  readonly workspacePath: string
  readonly agent: AgentSession
  readonly controller: AbortController
  readonly tools: Map<string, ToolNote>
  // The pump is forked after the provider session exists, so it is not there at first
  pump: Fiber.Fiber<void> | undefined
  // The turn that is running, the one that events are told on
  turn: TurnRef | null
  // The turn the kernel has asked the agent to interrupt: what that turn still asks is moot
  interrupted: string | null
  // Set once the kernel has let the provider session go, and then nothing it still says counts
  closed: boolean
}

// The provider sessions that are attached, the lock of each session and the extra environment given at creation
export class LiveSessions {
  private readonly lives = new Map<string, Live>()
  private readonly locks = new Map<string, Semaphore.Semaphore>()
  private readonly environments = new Map<string, Readonly<Record<string, string>>>()

  public get(sessionId: string): Live | undefined {
    return this.lives.get(sessionId)
  }

  public add(live: Live): void {
    this.lives.set(live.session.id, live)
  }

  // Only the attached session itself is dropped, never a newer one that took its place
  public remove(live: Live): void {
    if (this.lives.get(live.session.id) === live) {
      this.lives.delete(live.session.id)
    }
  }

  public all(): readonly Live[] {
    return [...this.lives.values()]
  }

  public setEnvironment(sessionId: string, environment: Readonly<Record<string, string>>): void {
    this.environments.set(sessionId, environment)
  }

  public environmentOf(sessionId: string): Readonly<Record<string, string>> {
    return this.environments.get(sessionId) ?? {}
  }

  // One change at a time per session: the commands of the caller and the events of the provider take turns
  public exclusive<Value, Failure, Requirements>(
    sessionId: string,
    effect: Effect.Effect<Value, Failure, Requirements>,
  ): Effect.Effect<Value, Failure, Requirements> {
    return this.lockOf(sessionId).withPermits(1)(effect)
  }

  private lockOf(sessionId: string): Semaphore.Semaphore {
    const existing = this.locks.get(sessionId)
    if (existing !== undefined) {
      return existing
    }
    const created = Semaphore.makeUnsafe(1)
    this.locks.set(sessionId, created)
    return created
  }
}
