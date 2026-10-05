import { m } from '@bytebureau/i18n'
import type {
  AskRecord,
  PluginStatusDto,
  ProfileDto,
  ProfileStatusDto,
  SessionDto,
} from '@bytebureau/protocol'
import { flat } from './tables.js'

// The rows a listing is told in, for table(): one row to a record, a cell to each of its columns

export const sessionRows = (sessions: readonly SessionDto[]): string[][] =>
  sessions.map((session) => [session.id, session.status, session.title, session.projectId])

// The fields of one session: a label and a value to each; a session that has no worktree yet, or runs under the nameless login, has a dash
export const sessionFields = (session: SessionDto): string[][] => [
  ['id', session.id],
  ['status', session.status],
  ['title', session.title],
  ['project', session.projectId],
  ['employee', session.employee.id],
  ['provider', session.providerId],
  ['profile', session.profileId ?? '-'],
  ['worktree', session.workspace === null ? '-' : session.workspace.path],
  ['created', session.createdAt],
]

// What the agent recommends, as the labels of the recommended options of all the questions
const recommendedOf = (ask: AskRecord): string =>
  ask.questions
    .flatMap((question) =>
      question.options.filter((option) => option.recommended).map((option) => option.label),
    )
    .join(', ')

export const askRows = (asks: readonly AskRecord[]): string[][] =>
  asks.map((ask) => [ask.id, ask.sessionId, ask.title, recommendedOf(ask)])

// The asks that wait for an answer to a session, a line to each: the title of an ask may hold the lines of a command
export const pendingAskLines = (asks: readonly AskRecord[]): string[] =>
  asks.map((ask) => m.sessions_pending_ask({ id: ask.id, title: flat(ask.title) }))

// A plugin that failed to load tells why in place of its ports
export const pluginRows = (plugins: readonly PluginStatusDto[]): string[][] =>
  plugins.map((plugin) => [
    plugin.name,
    plugin.version,
    plugin.state,
    plugin.state === 'failed' ? (plugin.reason ?? '') : plugin.ports.join(','),
  ])

// The default of its provider carries the marker; an API-key profile has no login directory
export const profileRows = (profiles: readonly ProfileDto[], marker: string): string[][] =>
  profiles.map((profile) => [
    profile.id,
    profile.providerId,
    profile.kind,
    profile.isDefault ? marker : '',
    profile.configDir ?? '-',
  ])

export const profileStatusRows = (statuses: readonly ProfileStatusDto[]): string[][] =>
  statuses.map((status) => [
    status.profileId,
    status.state,
    status.account ?? '-',
    status.hint ?? '',
  ])
