import { HttpApi, OpenApi } from 'effect/http-api'
import { AsksGroup } from './groups/asks.js'
import { EventsGroup } from './groups/events.js'
import { HealthGroup } from './groups/health.js'
import { PluginsGroup } from './groups/plugins.js'
import { ProjectsGroup } from './groups/projects.js'
import { SchemasGroup } from './groups/schemas.js'
import { SessionsGroup } from './groups/sessions.js'
import { UsageGroup } from './groups/usage.js'
import { WorkspacesGroup } from './groups/workspaces.js'

export const API_PREFIX = '/api/v1'

export const BureauApi = HttpApi.make('bytebureau')
  .add(
    HealthGroup,
    SchemasGroup,
    ProjectsGroup,
    SessionsGroup,
    AsksGroup,
    UsageGroup,
    WorkspacesGroup,
    PluginsGroup,
    EventsGroup,
  )
  .prefix(API_PREFIX)
  .annotate(OpenApi.Title, 'ByteBureau API')
  .annotate(OpenApi.Version, 'v1')
  .annotate(
    OpenApi.Description,
    'The local daemon of ByteBureau: projects, sessions, asks, usage, workspaces, plugins and the event stream.',
  )
