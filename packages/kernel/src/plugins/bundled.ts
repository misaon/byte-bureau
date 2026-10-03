import type { Plugin } from '@bytebureau/plugin-api'
import { localWorkspacePlugin } from '@bytebureau/workspace-local'
import { fakeAgentPlugin } from '../testing/fake-agent-plugin.js'

export const HOST_API_VERSION = '0.0.0'
// The fake agent ships on purpose: it is the documented way to smoke-test an installation without an agent subscription
export const BUNDLED_PLUGINS: readonly Plugin[] = [localWorkspacePlugin, fakeAgentPlugin]
