import { ProfileService } from '@bytebureau/kernel'
import { HttpApiBuilder } from 'effect/http-api'
import { BureauApi } from '../api.js'
import { orProblem } from '../problems.js'

export const ProfilesHandlers = HttpApiBuilder.group(BureauApi, 'profiles', (handlers) =>
  handlers
    .handle('list', () => orProblem(ProfileService.use((profiles) => profiles.list())))
    .handle('add', ({ payload }) =>
      orProblem(ProfileService.use((profiles) => profiles.add(payload))),
    )
    .handle('remove', ({ params, query }) =>
      orProblem(
        ProfileService.use((profiles) =>
          profiles.remove(params.id, { purge: query.purge === 'true' }),
        ),
      ),
    )
    .handle('setDefault', ({ params }) =>
      orProblem(ProfileService.use((profiles) => profiles.setDefault(params.id))),
    )
    .handle('status', ({ params }) =>
      orProblem(ProfileService.use((profiles) => profiles.status(params.id))),
    ),
)
