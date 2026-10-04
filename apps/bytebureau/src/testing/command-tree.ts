import { defineCommand, type CommandDef } from 'citty'
import { globalArgs, type GlobalArgs } from '../context.js'

// What a leaf was given: its raw arguments, the global flags it parsed, and the positional and the flag of its own
interface Given {
  readonly command: string
  readonly rawArgs: readonly string[]
  readonly json: boolean
  readonly lang: string | undefined
  readonly debug: string | undefined
  readonly host: string | undefined
  readonly port: string | undefined
  readonly other: string | undefined
  readonly positional: string | undefined
}

export interface Tree {
  readonly command: CommandDef
  // What the leaves were given
  readonly given: Given[]
  // What the root was given, when it ran itself
  readonly rooted: (readonly string[])[]
}

interface Seen {
  readonly rawArgs: readonly string[]
  readonly args: GlobalArgs
}

interface Own {
  readonly other?: string | undefined
  readonly positional?: string | undefined
}

function givenBy(command: string, seen: Seen, own: Own = {}): Given {
  const { rawArgs, args } = seen
  return {
    command,
    rawArgs,
    json: args.json,
    lang: args.lang,
    debug: args.debug,
    host: args.host,
    port: args.port,
    other: own.other,
    positional: own.positional,
  }
}

const HELLO_ARGS = { ...globalArgs, name: { type: 'positional', required: false } } as const
const LS_ARGS = { ...globalArgs, prompt: { type: 'positional', required: false } } as const
const ANSWER_ARGS = {
  ...globalArgs,
  id: { type: 'positional', required: false },
  other: { type: 'string' },
} as const

function helloOf(given: Given[]): CommandDef<typeof HELLO_ARGS> {
  return defineCommand({
    meta: { name: 'hello', description: 'Greet' },
    args: HELLO_ARGS,
    run(context) {
      given.push(givenBy('hello', context, { positional: context.args.name }))
    },
  })
}

function lsOf(given: Given[]): CommandDef<typeof LS_ARGS> {
  return defineCommand({
    meta: { name: 'ls', description: 'List the projects of the bureau' },
    args: LS_ARGS,
    run(context) {
      given.push(givenBy('ls', context, { positional: context.args.prompt }))
    },
  })
}

function answerOf(given: Given[]): CommandDef<typeof ANSWER_ARGS> {
  return defineCommand({
    meta: { name: 'answer', description: 'Answer an ask' },
    args: ANSWER_ARGS,
    run(context) {
      const { id, other } = context.args
      given.push(givenBy('answer', context, { positional: id, other }))
    },
  })
}

// The tree of bytebureau as it is built: a root with the global flags that tells the status when no sub-command is named, a leaf, and two groups of a leaf
export function tree(): Tree {
  const given: Given[] = []
  const rooted: (readonly string[])[] = []
  const projects = defineCommand({
    meta: { name: 'projects', description: 'Manage projects' },
    subCommands: { ls: lsOf(given) },
  })
  const ask = defineCommand({
    meta: { name: 'ask', description: 'List and answer asks' },
    subCommands: { answer: answerOf(given) },
  })
  const command: CommandDef = {
    meta: { name: 'bb', description: 'Root' },
    args: { ...globalArgs },
    subCommands: { hello: helloOf(given), projects, ask },
    run({ rawArgs, args }) {
      if (args._.length === 0) {
        rooted.push(rawArgs)
      }
    },
  }
  return { command, given, rooted }
}
