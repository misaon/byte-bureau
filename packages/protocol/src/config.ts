import { Schema } from 'effect'
import { Effort, PermissionMode, ProfileKind } from './common.js'
import { Appearance, ToolPolicy } from './employee.js'

export const LogLevel = Schema.Literals(['trace', 'debug', 'info', 'warn', 'error'])

// A whole number and a unit, as the kernel parses it: 500ms, 30s, 30m, 1h
const DurationText = Schema.String.check(Schema.isPattern(/^\d+\s*(?:ms|s|m|h)$/u))

export const EmployeeConfig = Schema.Struct({
  name: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  effort: Schema.optionalKey(Schema.NullOr(Effort)),
  prompt: Schema.optionalKey(Schema.String),
  systemPrompt: Schema.optionalKey(Schema.String),
  permissionMode: PermissionMode,
  tools: Schema.optionalKey(ToolPolicy),
  skills: Schema.optionalKey(Schema.Array(Schema.String)),
  maxTurns: Schema.optionalKey(Schema.Int),
  askTimeout: Schema.optionalKey(DurationText),
  appearance: Schema.optionalKey(Appearance),
})

export const PluginRef = Schema.Union([
  Schema.String,
  Schema.Struct({ npm: Schema.String, version: Schema.optionalKey(Schema.String) }),
])

const LoggingSection = Schema.Struct({ level: Schema.optionalKey(LogLevel) })

const WorkspaceSection = Schema.Struct({
  runtime: Schema.optionalKey(Schema.String),
  copyIgnored: Schema.optionalKey(Schema.Array(Schema.String)),
  retainDays: Schema.optionalKey(Schema.Int),
})
// The kernel reads passEnv: the names of further variables of its environment an agent of the provider is given
// Every other key belongs to the provider plugin
const PassEnv = Schema.optionalKey(Schema.Array(Schema.String))
const ProviderSection = Schema.StructWithRest(Schema.Struct({ passEnv: PassEnv }), [
  Schema.Record(Schema.String, Schema.Unknown),
])
const ProvidersSection = Schema.Record(Schema.String, ProviderSection)
const ProjectDefaults = Schema.Struct({
  employee: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
})

export const ProjectConfig = Schema.Struct({
  $schema: Schema.optionalKey(Schema.String),
  version: Schema.Literal(1),
  project: Schema.Struct({
    name: Schema.NonEmptyString,
    defaultBranch: Schema.optionalKey(Schema.String),
  }),
  workspace: Schema.optionalKey(WorkspaceSection),
  providers: Schema.optionalKey(ProvidersSection),
  employees: Schema.Record(Schema.String, EmployeeConfig),
  defaults: Schema.optionalKey(ProjectDefaults),
  plugins: Schema.optionalKey(Schema.Array(PluginRef)),
  logging: Schema.optionalKey(LoggingSection),
}).annotate({ title: 'ByteBureau project configuration (v1)' })

const ServerSection = Schema.Struct({
  host: Schema.optionalKey(Schema.String),
  port: Schema.optionalKey(Schema.Int),
})
const UserDefaults = Schema.Struct({
  provider: Schema.optionalKey(Schema.String),
  profile: Schema.optionalKey(Schema.String),
})
const UserProfile = Schema.Struct({
  providerId: Schema.String,
  name: Schema.String,
  kind: ProfileKind,
  configDir: Schema.optionalKey(Schema.String),
})
const ProfilesSection = Schema.Record(Schema.String, UserProfile)
const TelemetrySection = Schema.Struct({
  content: Schema.optionalKey(Schema.Literals(['local', 'off'])),
  otlpEndpoint: Schema.optionalKey(Schema.String),
})
const UiSection = Schema.Record(Schema.String, Schema.Unknown)

// Where the daemon keeps secrets: the OS keychain through Bun.secrets, a 0600 file under the home, or whichever of the two works (auto)
export const SecretsBackend = Schema.Literals(['auto', 'keychain', 'file'])
const SecretsSection = Schema.Struct({ backend: Schema.optionalKey(SecretsBackend) })

// A path from the root, POSIX or Windows: a relative one would name a different project from every working directory
const AbsolutePath = Schema.String.check(
  Schema.isPattern(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u, { expected: 'an absolute path' }),
)

// What a project's own files may run: the commands of providers.<id> run for a project listed by its path, or a command listed by its exact name or path
const TrustSection = Schema.Struct({
  projects: Schema.optionalKey(Schema.Array(AbsolutePath)),
  commands: Schema.optionalKey(Schema.Array(Schema.String)),
})

export const UserConfig = Schema.Struct({
  server: Schema.optionalKey(ServerSection),
  profiles: Schema.optionalKey(ProfilesSection),
  defaults: Schema.optionalKey(UserDefaults),
  locale: Schema.optionalKey(Schema.String),
  logging: Schema.optionalKey(LoggingSection),
  telemetry: Schema.optionalKey(TelemetrySection),
  secrets: Schema.optionalKey(SecretsSection),
  trust: Schema.optionalKey(TrustSection),
  ui: Schema.optionalKey(UiSection),
}).annotate({ title: 'ByteBureau user configuration' })

export type LogLevel = typeof LogLevel.Type
export type EmployeeConfig = typeof EmployeeConfig.Type
export type PluginRef = typeof PluginRef.Type
export type ProjectConfig = typeof ProjectConfig.Type
export type SecretsBackend = typeof SecretsBackend.Type
export type UserConfig = typeof UserConfig.Type

const STRICT = { onExcessProperty: 'error', errors: 'all' } as const

export const decodeProjectConfig = (input: unknown): ProjectConfig =>
  Schema.decodeUnknownSync(ProjectConfig)(input, STRICT)
export const decodeUserConfig = (input: unknown): UserConfig =>
  Schema.decodeUnknownSync(UserConfig)(input, STRICT)

// The branch keys are left out on purpose: a default here would hide the one detected from each repository
export const defaultProjectConfig: ProjectConfig = {
  version: 1,
  project: { name: 'my-app' },
  workspace: { runtime: 'local', copyIgnored: ['.env', '.env.local'], retainDays: 7 },
  providers: { claude: { executable: 'claude', settingSources: ['user', 'project', 'local'] } },
  employees: {
    developer: {
      name: 'Developer',
      provider: 'claude',
      model: 'claude-opus-5-5',
      effort: 'medium',
      prompt: './.bytebureau/employees/developer.md',
      permissionMode: 'supervised',
      tools: { allow: [], deny: [] },
      skills: [],
      askTimeout: '30m',
      appearance: {},
    },
  },
  defaults: { employee: 'developer' },
  plugins: [],
  logging: { level: 'info' },
}
