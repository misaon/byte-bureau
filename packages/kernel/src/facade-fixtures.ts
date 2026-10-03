import type { EventEnvelope } from '@bytebureau/protocol'
import { onTestFinished } from 'vitest'
import { createKernelFrom, type Kernel, type KernelOptions } from './facade.js'
import { KernelTest, type KernelLayerOptions } from './kernel-live.js'
import type { Session } from './sessions/types.js'
import { createTempRepo, tempDir } from './testing/temp-repo.js'

type Extras = Pick<KernelLayerOptions, 'extraPlugins'> & Partial<Pick<KernelOptions, 'env'>>

// A kernel logs its own warnings, such as an employee without a prompt file; a test is not about them
export const QUIET: KernelOptions['logging'] = { level: 'error' }

// A kernel over the in-memory store, closed when the test is over; closing it earlier does no harm
export async function openKernel(extras: Extras = {}): Promise<Kernel> {
  const home = tempDir('bb-home-')
  const layer = KernelTest({ home, extraPlugins: extras.extraPlugins })
  const kernel = await createKernelFrom(layer, {
    home,
    env: extras.env ?? {},
    logging: QUIET,
  })
  onTestFinished(async () => {
    await kernel.close()
  })
  return kernel
}

// A session of the fake agent in a fresh repository, ready for its first prompt
export async function startFakeSession(kernel: Kernel): Promise<Session> {
  const project = await kernel.projects.register(createTempRepo())
  return kernel.sessions.create({ projectId: project.id, title: 'facade', providerId: 'fake' })
}

// The events up to the first the predicate accepts, which is included; the loop is left there
export async function eventsUntil(
  events: AsyncIterable<EventEnvelope>,
  accepts: (event: EventEnvelope) => boolean,
): Promise<readonly EventEnvelope[]> {
  const seen: EventEnvelope[] = []
  for await (const event of events) {
    seen.push(event)
    if (accepts(event)) {
      break
    }
  }
  return seen
}
