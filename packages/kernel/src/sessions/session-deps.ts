import type { Scope } from 'effect'
import type { KernelInstance, LiveSessions } from './live-sessions.js'
import type { SessionServices } from './session-collect.js'

// The environment of the kernel: what configuration reads its BYTEBUREAU_* overrides from
export type KernelEnv = Readonly<Record<string, string | undefined>>

// The services the session manager works with, and what it keeps of the sessions that are running
export interface SessionDeps extends SessionServices {
  readonly env: KernelEnv
  readonly live: LiveSessions
  // A session this kernel registers, resumes or prompts is recorded as its own, so the recovery of another kernel leaves it alone
  readonly instance: KernelInstance
  // The fibers of the sessions (the pumps of provider events, the prompts on their way) live in a scope of their own: as long as the layer, not as long as the call that started them
  // The layer closes it once the provider sessions are closed, so a pump that waits for its provider cannot hold the closing of the agents
  readonly scope: Scope.Closeable
}
