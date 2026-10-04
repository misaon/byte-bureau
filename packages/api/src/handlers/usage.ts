import { ProfileService, SessionManager, UsageService } from '@bytebureau/kernel'
import type { UsageSnapshotDto } from '@bytebureau/protocol'
import { Effect } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { BureauApi } from '../api.js'
import { orProblem, type ApiProblem, type KernelStatus } from '../problems.js'
import { found } from './found.js'

// A profile nobody holds is not found; one the kernel has seen no rate limit of has an empty snapshot, not none
// The REST API and the RPC socket ask the same way
export const profileUsageOf = (
  id: string,
): Effect.Effect<UsageSnapshotDto, ApiProblem<KernelStatus>, ProfileService | UsageService> =>
  orProblem(ProfileService.use((profiles) => profiles.get(id))).pipe(
    Effect.flatMap((profile) => found(profile, 'profile_not_found', `no profile "${id}"`)),
    Effect.flatMap(() => orProblem(UsageService.use((usage) => usage.snapshot(id)))),
    Effect.map((snapshot) => snapshot ?? { profileId: id, rateLimit: {}, observedAt: null }),
  )

// The usage of a session that is not there is not found, not nothing used
export const UsageHandlers = HttpApiBuilder.group(BureauApi, 'usage', (handlers) =>
  handlers
    .handle('session', ({ params }) =>
      orProblem(SessionManager.use((sessions) => sessions.get(params.id))).pipe(
        Effect.flatMap((session) => found(session, 'session_not_found', `no session ${params.id}`)),
        Effect.flatMap(() => orProblem(UsageService.use((usage) => usage.sessionUsage(params.id)))),
      ),
    )
    .handle('profile', ({ params }) => profileUsageOf(params.id)),
)
