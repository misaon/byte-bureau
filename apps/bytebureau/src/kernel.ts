import { createKernel, type Kernel } from '@bytebureau/kernel/bun'
import type { Context } from './context.js'
import { kernelHome } from './kernel-home.js'
import { withResource } from './resource.js'

// One in-process kernel per command invocation (--no-daemon mode); Phase B adds the daemon client
export async function withKernel<Result>(
  context: Context,
  env: Readonly<Record<string, string | undefined>>,
  work: (kernel: Kernel) => Promise<Result>,
): Promise<Result> {
  const open = async (): Promise<Kernel> => {
    const kernel = await createKernel({ home: kernelHome(env), env, logging: context.logging })
    return kernel
  }
  const result = await withResource(open, work)
  return result
}
