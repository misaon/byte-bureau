import { Context } from 'effect'
import { Config } from '../config/config.js'
import type { Promised, Services } from './promised.js'
import type { Kernel, KernelOptions } from './types.js'

// The overrides come from the environment the caller gave
export const configApi = (
  promised: Promised,
  services: Context.Context<Services>,
  env: KernelOptions['env'],
): Kernel['config'] => ({
  load: promised(Config, (config, projectPath) => config.load({ projectPath, env })),
  validate: promised(Config, (config, projectPath) => config.validate(projectPath, env)),
  schema: () => Context.get(services, Config).schema(),
})
