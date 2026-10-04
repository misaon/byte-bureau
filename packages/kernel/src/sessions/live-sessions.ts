import type { AgentSession } from '@bytebureau/plugin-api'
import { Effect, Semaphore, type Fiber } from 'effect'
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
  // Whether the provider says its agent can be interrupted, which is when the questions of an interrupted turn are moot
  readonly interruptible: boolean
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

// What the agent of a session gets besides the allowlisted environment of the kernel, as its creation decided
export interface SessionEnvironment {
  // Extra variables given at creation; only the BYTEBUREAU_* names are passed on
  readonly extra: Readonly<Record<string, string>>
  // The names of further variables of the kernel's environment, from providers.<id>.passEnv
  readonly passEnv: readonly string[]
}

const NO_ENVIRONMENT: SessionEnvironment = { extra: {}, passEnv: [] }

interface Lock {
  readonly semaphore: Semaphore.Semaphore
  // Those that hold the lock or wait for it; an entry nobody uses is let go
  users: number
}

// The provider sessions that are attached, the lock of each session and the environment given at creation
// A lock exists while somebody holds or waits for it and an environment until its session ends, so neither map grows in a daemon
export class LiveSessions {
  private readonly lives = new Map<string, Live>()
  private readonly locks = new Map<string, Lock>()
  private readonly environments = new Map<string, SessionEnvironment>()

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

  public setEnvironment(sessionId: string, environment: SessionEnvironment): void {
    this.environments.set(sessionId, environment)
  }

  public environmentOf(sessionId: string): SessionEnvironment {
    return this.environments.get(sessionId) ?? NO_ENVIRONMENT
  }

  // The session has ended: its environment goes; a resume reads it back from the record of the session
  public forget(sessionId: string): void {
    this.environments.delete(sessionId)
  }

  // How many locks and environments are kept, which the daemon's health and the tests read
  public sizes(): { readonly locks: number; readonly environments: number } {
    return { locks: this.locks.size, environments: this.environments.size }
  }

  // One change at a time per session: the commands of the caller and the events of the provider take turns
  public exclusive<Value, Failure, Requirements>(
    sessionId: string,
    effect: Effect.Effect<Value, Failure, Requirements>,
  ): Effect.Effect<Value, Failure, Requirements> {
    return Effect.acquireUseRelease(
      Effect.sync(() => this.enter(sessionId)),
      (semaphore) => semaphore.withPermits(1)(effect),
      () =>
        Effect.sync(() => {
          this.leave(sessionId)
        }),
    )
  }

  private enter(sessionId: string): Semaphore.Semaphore {
    const lock = this.locks.get(sessionId) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 }
    lock.users += 1
    this.locks.set(sessionId, lock)
    return lock.semaphore
  }

  private leave(sessionId: string): void {
    const lock = this.locks.get(sessionId)
    if (lock === undefined) {
      return
    }
    lock.users -= 1
    if (lock.users === 0) {
      this.locks.delete(sessionId)
    }
  }
}
