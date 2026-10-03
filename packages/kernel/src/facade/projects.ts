import { ProjectRegistry } from '../projects/project-registry.js'
import type { Promised } from './promised.js'
import type { Kernel } from './types.js'

export const projectsApi = (promised: Promised): Kernel['projects'] => ({
  register: promised(ProjectRegistry, (registry, path) => registry.register(path)),
  list: promised(ProjectRegistry, (registry) => registry.list()),
  get: promised(ProjectRegistry, (registry, id) => registry.get(id)),
  remove: promised(ProjectRegistry, (registry, id) => registry.remove(id)),
})
