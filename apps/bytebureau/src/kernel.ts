import { createKernel, type Kernel } from '@bytebureau/kernel/bun'
import type { Context } from './context.js'
import { kernelHome } from './kernel-home.js'

// The kernel of this process, on the home and with the environment of the command: --no-daemon, and config validate and schema
export async function openKernel(context: Context): Promise<Kernel> {
  const kernel = await createKernel({
    home: kernelHome(context.env),
    env: context.env,
    logging: context.logging,
  })
  return kernel
}
