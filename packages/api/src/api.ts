import { HttpApi, OpenApi } from 'effect/http-api'
import { HealthGroup } from './groups/health.js'
import { SchemasGroup } from './groups/schemas.js'

export const API_PREFIX = '/api/v1'

export const BureauApi = HttpApi.make('bytebureau')
  .add(HealthGroup, SchemasGroup)
  .prefix(API_PREFIX)
  .annotate(OpenApi.Title, 'ByteBureau API')
  .annotate(OpenApi.Version, 'v1')
  .annotate(
    OpenApi.Description,
    'The local daemon of ByteBureau: projects, sessions, asks, usage, workspaces, plugins and the event stream.',
  )
