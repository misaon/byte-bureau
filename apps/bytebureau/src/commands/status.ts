import { m } from '@bytebureau/i18n'
import { serverUrl, type HealthDto } from '@bytebureau/protocol'
import { defineCommand } from 'citty'
import type { Bureau } from '../bureau/bureau.js'
import { bureauFlags, globalArgs, processContext, type Context } from '../context.js'
import { readServerInfo, type ServerRecord } from '../daemon/server-info.js'
import { kernelHome } from '../kernel-home.js'
import { withBureauRefusable } from './refusable.js'

interface Counts {
  readonly projects: number
  readonly sessions: { readonly running: number; readonly waiting: number; readonly total: number }
  readonly pendingAsks: number
}

interface Gathered {
  readonly where: Bureau['where']
  readonly health: HealthDto
  readonly counts: Counts
}

// The daemon the Bureau talked to; its pid is known only from the record of this home, and only when that record names the same daemon
interface Daemon {
  readonly url: string
  readonly pid: number | undefined
  readonly version: string
  readonly startedAt: string
}

async function gather(bureau: Bureau): Promise<Gathered> {
  const [projects, sessions, asks, health] = await Promise.all([
    bureau.projects.list(),
    bureau.sessions.list(),
    bureau.asks.pending(),
    bureau.health.check(),
  ])
  const running = sessions.filter((session) => session.status === 'running').length
  const waiting = sessions.filter((session) => session.status === 'waiting_for_human').length
  return {
    where: bureau.where,
    health,
    counts: {
      projects: projects.length,
      sessions: { running, waiting, total: sessions.length },
      pendingAsks: asks.length,
    },
  }
}

// None for the kernel in the process of the command; a daemon of another home, named by --host and --port, has no pid here
function daemonOf({ where, health }: Gathered, record: ServerRecord): Daemon | undefined {
  if (where.kind === 'in-process') {
    return undefined
  }
  const pid =
    record.state === 'alive' && serverUrl(record.info) === where.url ? record.info.pid : undefined
  return { url: where.url, pid, version: health.version, startedAt: health.startedAt }
}

function daemonLine(daemon: Daemon | undefined): string {
  if (daemon === undefined) {
    return m.status_in_process()
  }
  const { url, pid, startedAt: since } = daemon
  return pid === undefined
    ? m.status_daemon_remote({ url, since })
    : m.status_daemon({ url, pid, since })
}

function tell(context: Context, daemon: Daemon | undefined, counts: Counts): void {
  context.output.emit({ command: 'status', ...(daemon === undefined ? {} : { daemon }), ...counts })
  context.output.print(daemonLine(daemon))
  context.output.print(m.status_projects({ count: counts.projects }))
  context.output.print(m.status_sessions(counts.sessions))
  context.output.print(m.status_asks({ count: counts.pendingAsks }))
}

// What bytebureau says when it is called with nothing else: the daemon (started on demand), its projects, sessions and asks
// It is no command to name: the root of the CLI runs it for a call with no sub-command
export const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Tell the daemon, the projects, the sessions and the asks' },
  args: { ...globalArgs },
  async run({ args }) {
    const context = processContext(args)
    const gathered = await withBureauRefusable(context, bureauFlags(args), gather)
    if (gathered !== undefined) {
      const record = readServerInfo(kernelHome(context.env))
      tell(context, daemonOf(gathered, record), gathered.counts)
    }
  },
})
