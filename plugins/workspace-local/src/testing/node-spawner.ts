import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import type { ExecHandle, ExecSpec, ProcessSpawner } from '@bytebureau/plugin-api'

async function* lines(stream: NodeJS.ReadableStream | null): AsyncIterable<string> {
  if (stream === null) {
    return
  }
  for await (const line of createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY,
  })) {
    yield line
  }
}

async function exitOf(child: ChildProcess): Promise<Awaited<ExecHandle['exited']>> {
  await once(child, 'close')
  return { code: child.exitCode, signal: child.signalCode }
}

export const nodeSpawner: ProcessSpawner = {
  async spawn(spec: ExecSpec & { readonly cwd: string }): Promise<ExecHandle> {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      signal: spec.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await once(child, 'spawn')
    return {
      pid: child.pid ?? -1,
      stdout: lines(child.stdout),
      stderr: lines(child.stderr),
      exited: exitOf(child),
      kill(signal = 'SIGTERM') {
        child.kill(signal)
      },
    }
  },
}
