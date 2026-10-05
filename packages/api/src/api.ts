import { HttpApi, OpenApi } from 'effect/http-api'
import { EventsGroup } from './groups/events.js'
import { HealthGroup } from './groups/health.js'
import { PluginsGroup } from './groups/plugins.js'
import { RESOURCE_GROUPS } from './groups/resources.js'
import { SchemasGroup } from './groups/schemas.js'

export const API_PREFIX = '/api/v1'

export const BureauApi = HttpApi.make('bytebureau')
  .add(HealthGroup, SchemasGroup, ...RESOURCE_GROUPS, PluginsGroup, EventsGroup)
  .prefix(API_PREFIX)
  .annotate(OpenApi.Title, 'ByteBureau API')
  .annotate(OpenApi.Version, 'v1')
  .annotate(
    OpenApi.Description,
    'The local daemon of ByteBureau: projects, profiles, sessions, asks, usage, workspaces, plugins and the event stream.',
  )
