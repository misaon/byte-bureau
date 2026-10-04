import { PluginStatusDto, ProviderDto } from '@bytebureau/protocol'
import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { Authorization } from '../auth.js'
import { RequestValidation } from '../validation.js'

export const PluginsGroup = HttpApiGroup.make('plugins')
  .add(
    HttpApiEndpoint.get('list', '/plugins', { success: Schema.Array(PluginStatusDto) }),
    HttpApiEndpoint.get('providers', '/providers', { success: Schema.Array(ProviderDto) }),
  )
  .middleware(Authorization)
  .middleware(RequestValidation)
