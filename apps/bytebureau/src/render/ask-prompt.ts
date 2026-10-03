import { m } from '@bytebureau/i18n'
import type { Ask, AskAnswer, AskOption, AskQuestion } from '@bytebureau/protocol'
import { isCancel, select, text, type Option } from '@clack/prompts'

export interface AskPromptOptions {
  readonly yes: boolean
  readonly interactive: boolean
}

// The prompts a person answers through; a test can put others in place of the terminal's
export interface Prompts {
  readonly select: typeof select<string>
  readonly text: typeof text
}

const TERMINAL: Prompts = { select, text }

// The value of the extra choice that lets a person write an answer
const OTHER = '__other__'

// The id of the one recommended option; a question without one, or with several, has none to take
function onlyRecommended(question: AskQuestion): string | undefined {
  const recommended = question.options.filter((option) => option.recommended)
  const [only] = recommended
  return recommended.length === 1 && only !== undefined ? only.id : undefined
}

// --yes: every question gets its recommended option; an ask without that is left to the kernel policy
function recommendedAnswer(ask: Ask): AskAnswer | undefined {
  if (ask.recommendationSource === 'none') {
    return undefined
  }
  const picks = ask.questions.map((question) => onlyRecommended(question))
  return picks.every((pick) => pick !== undefined) ? { selected: picks } : undefined
}

// An agent often marks the label it recommends itself, in English or in Czech: one marker is enough
const MARKED = /\((?:recommended|doporučeno)\)\s*$/iu

function labelOf(option: AskOption): string {
  const needsMarker = option.recommended && !MARKED.test(option.label)
  return needsMarker ? `${option.label} ${m.run_ask_recommended()}` : option.label
}

function choicesOf(question: AskQuestion): Option<string>[] {
  const choices = question.options.map((option) => ({
    value: option.id,
    label: labelOf(option),
    ...(option.description === undefined ? {} : { hint: option.description }),
  }))
  return question.allowOther ? [...choices, { value: OTHER, label: m.run_ask_other() }] : choices
}

// The recommended option is where the cursor starts, else the first one
function startOf(question: AskQuestion): { readonly initialValue: string } | undefined {
  const [first] = question.options
  const start = question.options.find((option) => option.recommended) ?? first
  return start === undefined ? undefined : { initialValue: start.id }
}

async function writeOwnAnswer(prompts: Prompts): Promise<AskAnswer | undefined> {
  const written = await prompts.text({ message: m.run_ask_other_prompt() })
  return isCancel(written) ? undefined : { selected: 'other', otherText: written }
}

// The questions are put one after the other; "Other" ends them with the words of the person
async function askFrom(
  questions: readonly AskQuestion[],
  selected: readonly string[],
  prompts: Prompts,
): Promise<AskAnswer | undefined> {
  const [question, ...rest] = questions
  if (question === undefined) {
    return { selected }
  }
  const choice = await prompts.select({
    message: `${m.run_ask_header()}: ${question.prompt}`,
    options: choicesOf(question),
    ...startOf(question),
  })
  if (isCancel(choice)) {
    return undefined
  }
  return choice === OTHER ? writeOwnAnswer(prompts) : askFrom(rest, [...selected, choice], prompts)
}

// Undefined when nobody can answer (no --yes and no terminal, a cancel, no recommendation): the kernel policy decides
export async function promptAsk(
  ask: Ask,
  options: AskPromptOptions,
  prompts: Prompts = TERMINAL,
): Promise<AskAnswer | undefined> {
  if (options.yes) {
    return recommendedAnswer(ask)
  }
  const answer = options.interactive ? await askFrom(ask.questions, [], prompts) : undefined
  return answer
}
