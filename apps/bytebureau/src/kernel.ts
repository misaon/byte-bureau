import { homedir } from 'node:os'
import path from 'node:path'
import { createKernel, type Kernel } from '@bytebureau/kernel/bun'
import type { Context } from './context.js'

function kernelHome(env: Readonly<Record<string, string | undefined>>): string {
  return env['BYTEBUREAU_HOME'] ?? path.join(homedir(), '.bytebureau')
}

// One in-process kernel per command invocation (--no-daemon mode); Phase B adds the daemon client
export async function withKernel<Result>(
  context: Context,
  env: Readonly<Record<string, string | undefined>>,
  work: (kernel: Kernel) => Promise<Result>,
): Promise<Result> {
  const kernel = await createKernel({ home: kernelHome(env), env, logging: context.logging })
  try {
    return await work(kernel)
  } finally {
    await kernel.close()
  }
}
