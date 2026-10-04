import { Health } from '../health/health.js'
import type { Promised } from './promised.js'
import type { Kernel } from './types.js'

export const healthApi = (promised: Promised): Kernel['health'] => ({
  check: promised(Health, (health) => health.check()),
})
