import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { EmployeeConfig, EmployeeSpec } from '@bytebureau/protocol'
import { Effect } from 'effect'
import { SessionError } from '../errors.js'
import { reasonOf } from '../plugins/reason.js'
import type { Project } from '../projects/project-registry.js'
import { logger } from './session-deps.js'
import type { CreateSessionInput } from './types.js'

// The employee a session gets when nobody names one
const defaultEmployeeOf = ({ config }: Project): string =>
  config.defaults === undefined || config.defaults.employee === undefined
    ? 'developer'
    : config.defaults.employee

const isInside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

// The prompt file of a project is read from the project; a path that leads out of it, by dots or by a link, is not
const readPromptFile = async (project: Project, promptPath: string): Promise<string> => {
  const root = await realpath(project.path)
  const file = await realpath(path.resolve(project.path, promptPath))
  if (!isInside(root, file)) {
    throw new Error('the prompt file is outside the project')
  }
  const text = await readFile(file, 'utf8')
  return text
}

// A prompt file that is missing or cannot be read leaves the employee without a system prompt, and the session is not refused for it
const readPromptOrNothing = (project: Project, promptPath: string): Effect.Effect<string> =>
  Effect.tryPromise({
    try: async () => {
      const text = await readPromptFile(project, promptPath)
      return text
    },
    catch: reasonOf,
  }).pipe(
    Effect.match({
      onFailure: (reason) => {
        logger.warn('employee prompt unreadable', { project: project.name, promptPath, reason })
        return ''
      },
      onSuccess: (text) => text,
    }),
  )

const promptOf = (project: Project, config: EmployeeConfig): Effect.Effect<string> => {
  if (config.systemPrompt !== undefined) {
    return Effect.succeed(config.systemPrompt)
  }
  return config.prompt === undefined
    ? Effect.succeed('')
    : readPromptOrNothing(project, config.prompt)
}

const specOf = (
  id: string,
  config: EmployeeConfig,
  extras: { readonly systemPrompt: string; readonly provider: string },
): EmployeeSpec => ({
  id,
  name: config.name,
  provider: extras.provider,
  model: config.model,
  effort: config.effort ?? null,
  systemPrompt: extras.systemPrompt,
  tools: config.tools ?? { allow: [], deny: [] },
  permissionMode: config.permissionMode,
  skills: config.skills ?? [],
  ...(config.maxTurns === undefined ? {} : { maxTurns: config.maxTurns }),
  askTimeout: config.askTimeout ?? '30m',
  appearance: config.appearance ?? {},
})

// What the caller chooses: the employee, and a provider to put in place of the one of the employee
export type EmployeeChoice = Pick<CreateSessionInput, 'employeeId' | 'providerId'>

// The employee of the project's configuration as a session carries it; a provider given by the caller replaces the one of the employee
export const employeeOf = (
  project: Project,
  choice: EmployeeChoice,
): Effect.Effect<EmployeeSpec, SessionError> =>
  Effect.gen(function* resolvesEmployee() {
    const id = choice.employeeId ?? defaultEmployeeOf(project)
    const { employees } = project.config
    const config = Object.hasOwn(employees, id) ? employees[id] : undefined
    if (config === undefined) {
      const reason = `employee "${id}" is not defined in bytebureau.json`
      return yield* new SessionError({ code: 'employee_missing', reason })
    }
    const systemPrompt = yield* promptOf(project, config)
    return specOf(id, config, { systemPrompt, provider: choice.providerId ?? config.provider })
  })
