import { askCommand } from './ask.js'
import { configCommand } from './config.js'
import { helloCommand } from './hello.js'
import { pluginsCommand } from './plugins.js'
import { profilesCommand } from './profiles.js'
import { projectsCommand } from './projects.js'
import { runCommand } from './run.js'
import { serveCommand } from './serve.js'
import { sessionsCommand } from './sessions.js'
import { workspacesCommand } from './workspaces.js'

// Every command of the CLI by the name it is called with
export const subCommands = {
  hello: helloCommand,
  run: runCommand,
  config: configCommand,
  projects: projectsCommand,
  workspaces: workspacesCommand,
  serve: serveCommand,
  sessions: sessionsCommand,
  ask: askCommand,
  plugins: pluginsCommand,
  profiles: profilesCommand,
}
