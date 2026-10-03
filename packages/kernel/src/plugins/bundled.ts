import type { Plugin } from '@bytebureau/plugin-api'
import { localWorkspacePlugin } from '@bytebureau/workspace-local'

export const HOST_API_VERSION = '0.0.0'
export const BUNDLED_PLUGINS: readonly Plugin[] = [localWorkspacePlugin]
