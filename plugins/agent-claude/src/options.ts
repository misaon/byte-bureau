import type { CanUseTool, Options } from '@anthropic-ai/claude-agent-sdk'
import type { CreateSessionRequest } from '@bytebureau/plugin-api'
import { claudeConfigOf } from './config.js'
import { permissionModeOf } from './permission.js'

export const CLAUDE_CONVENTIONS = [
  'ByteBureau conventions:',
  '- When you ask the person a question with AskUserQuestion, put the option you recommend first, end its label with " (Recommended)" and give one line of evidence in its description.',
  '- Work only inside the current working directory, which is an isolated git worktree of the project.',
].join('\n')

export interface OptionParts {
  readonly request: CreateSessionRequest
  readonly executable: string | undefined
  readonly abort: AbortController
  readonly hooks: NonNullable<Options['hooks']>
  readonly canUseTool: CanUseTool
}

// The environment of the child: what the kernel allowed, and the login directory of a login profile
// The key of an api_key profile is already in it, under ANTHROPIC_API_KEY, put there by the kernel
const envOf = ({ env, profile }: CreateSessionRequest): Record<string, string> => {
  const loginDir =
    profile.kind === 'login' && profile.configDir !== undefined
      ? { CLAUDE_CONFIG_DIR: profile.configDir }
      : {}
  return { ...env, ...loginDir }
}

const appendOf = (systemPrompt: string): string =>
  systemPrompt === '' ? CLAUDE_CONVENTIONS : `${systemPrompt}\n\n${CLAUDE_CONVENTIONS}`

// The options of the one query a session runs; the user's own claude when there is one, the SDK's bundled binary otherwise
export const optionsOf = ({
  request,
  executable,
  abort,
  hooks,
  canUseTool,
}: OptionParts): Options => {
  const config = claudeConfigOf(request.providerConfig)
  const { employee, resume } = request
  return {
    cwd: request.workspace.path,
    model: employee.model,
    ...(employee.effort === null ? {} : { effort: employee.effort }),
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: appendOf(employee.systemPrompt),
    },
    allowedTools: [...employee.tools.allow],
    disallowedTools: [...employee.tools.deny],
    ...(employee.maxTurns === undefined ? {} : { maxTurns: employee.maxTurns }),
    includePartialMessages: true,
    permissionMode: permissionModeOf(employee.permissionMode),
    env: envOf(request),
    settingSources: config.settingSources ?? ['user', 'project', 'local'],
    ...(executable === undefined ? {} : { pathToClaudeCodeExecutable: executable }),
    ...(resume !== undefined && resume.providerId === 'claude' ? { resume: resume.ref } : {}),
    abortController: abort,
    hooks,
    canUseTool,
    mcpServers: {},
  }
}
