import { m } from '@bytebureau/i18n'
import { defineCommand } from 'citty'
import { globalArgs, portOf, processContext, type Context } from '../context.js'
import { alreadyRunning, announce } from '../daemon/announce.js'
import { startDetached as started } from '../daemon/start.js'
import { stopDaemon, type StopOutcome } from '../daemon/stop.js'
import { runningDaemon } from '../daemon/wait.js'
import { kernelHome } from '../kernel-home.js'

interface ServeFlags {
  readonly host?: string | undefined
  readonly port?: string | undefined
  readonly 'log-level'?: string | undefined
  readonly debug?: string | undefined
}

// What the detached daemon is started with: the address and the logging of this command
const flagsOf = (flags: ServeFlags): string[] => [
  ...(flags.host === undefined ? [] : ['--host', flags.host]),
  ...(flags.port === undefined ? [] : ['--port', flags.port]),
  ...(flags['log-level'] === undefined ? [] : ['--log-level', flags['log-level']]),
  // A bare --debug arrives here as an empty value, which only the = form passes on as it is
  ...(flags.debug === undefined ? [] : [`--debug=${flags.debug}`]),
]

const stopped = (result: Exclude<StopOutcome, { outcome: 'still_running' }>): string => {
  if (result.outcome === 'stopped') {
    return m.serve_stopped({ pid: result.pid })
  }
  return result.outcome === 'cleared'
    ? m.serve_lock_cleared({ pid: result.pid })
    : m.serve_not_running()
}

// A daemon that is not running is what was asked for, and so is a lock cleared that no daemon of the home held; one that outlives the wait is a failure
async function stop(home: string, context: Context): Promise<number> {
  const result = await stopDaemon(home)
  context.output.emit({ command: 'serve.stop', ...result })
  if (result.outcome === 'still_running') {
    context.output.warn(m.serve_still_running({ pid: result.pid }))
    return 1
  }
  context.output.print(stopped(result))
  return 0
}

// A start that fails says why at once, naming the log or the lock
async function startDetached(home: string, flags: ServeFlags, context: Context): Promise<number> {
  const start = await started(home, process.env, flagsOf(flags))
  if (!start.up) {
    context.output.warn(start.reason)
    return 1
  }
  announce(start.info, context)
  return 0
}

// A daemon already serving the home is what was asked for; otherwise one is started detached and waited for
async function detach(home: string, flags: ServeFlags, context: Context): Promise<number> {
  const running = await runningDaemon(home)
  if (running !== undefined) {
    alreadyRunning(running, context)
    return 0
  }
  const code = await startDetached(home, flags, context)
  return code
}

interface ServeArgs extends ServeFlags {
  readonly daemonize: boolean
}

// Detached unless --no-daemonize; only the daemon itself loads the API and its server, so every other command stays clear of them
async function serve(home: string, args: ServeArgs, context: Context): Promise<number> {
  const port = portOf(args.port)
  if (args.daemonize) {
    const code = await detach(home, args, context)
    return code
  }
  const { serveForeground } = await import('../daemon/foreground.js')
  const code = await serveForeground({ home, env: process.env, host: args.host, port }, context)
  return code
}

export const serveCommand = defineCommand({
  meta: {
    name: 'serve',
    description: 'Start the ByteBureau daemon (detached unless --no-daemonize)',
  },
  args: {
    ...globalArgs,
    host: {
      type: 'string',
      description: 'Address to listen on (default: 127.0.0.1 or server.host)',
    },
    port: {
      type: 'string',
      description: 'Port to listen on (default: 4747 or server.port; 0 picks a free one)',
    },
    daemonize: {
      type: 'boolean',
      description: 'Detach; pass --no-daemonize to stay in the foreground',
      default: true,
    },
    stop: { type: 'boolean', description: 'Stop the running daemon of this home', default: false },
  },
  async run({ args }) {
    const context = processContext(args)
    const home = kernelHome(process.env)
    process.exitCode = args.stop ? await stop(home, context) : await serve(home, args, context)
  },
})
