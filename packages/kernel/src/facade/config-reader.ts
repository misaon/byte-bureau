import { Effect } from 'effect'
import { Config, ConfigLive, type ConfigIssue } from '../config/config.js'

export interface ConfigReader {
  // The issues of the layered configuration of a project, the environment layer included
  readonly validate: (projectPath: string) => Promise<readonly ConfigIssue[]>
  // The JSON Schema of the project file
  readonly schema: () => Record<string, unknown>
}

/**
 * The configuration of a home on its own, for a command that only reads it: no store, no plugins and no recovery, so
 * it never stands beside a daemon of the home as a second writer of the store.
 */
export const configReader = (
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): ConfigReader => {
  const read = Config.use(Effect.succeed).pipe(Effect.provide(ConfigLive(home)))
  const config = Effect.runSync(read)
  return {
    validate: async (projectPath) => {
      const issues = await Effect.runPromise(config.validate(projectPath, env))
      return issues
    },
    schema: () => config.schema(),
  }
}
