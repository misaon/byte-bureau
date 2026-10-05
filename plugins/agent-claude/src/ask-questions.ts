import type { AskAnswer, AskOption, AskQuestion } from '@bytebureau/protocol'
import { z } from 'zod'

// The input of AskUserQuestion as the SDK declares it; an input that does not fit asks nothing
const OptionSchema = z.object({ label: z.string(), description: z.optional(z.string()) })
const QuestionSchema = z.object({
  question: z.string(),
  header: z.string(),
  options: z.array(OptionSchema),
  multiSelect: z.optional(z.boolean()),
})
const InputSchema = z.object({ questions: z.array(QuestionSchema).min(1) })

type OptionInput = z.infer<typeof OptionSchema>

const SUFFIX = '(recommended)'
const HEADER_LIMIT = 12

// The convention of CLAUDE_CONVENTIONS: the recommended option ends its label with " (Recommended)"
const isRecommended = (label: string): boolean => label.trimEnd().toLowerCase().endsWith(SUFFIX)

const plainLabel = (label: string): string =>
  isRecommended(label) ? label.trimEnd().slice(0, -SUFFIX.length).trimEnd() : label

// The id is the plain label too, so a person answers with the label as it reads
const optionOf = ({ label, description }: OptionInput): AskOption => ({
  id: plainLabel(label),
  label: plainLabel(label),
  ...(description === undefined || description === '' ? {} : { description }),
  recommended: isRecommended(label),
  evidence: [],
})

export const questionsOf = (input: Readonly<Record<string, unknown>>): readonly AskQuestion[] => {
  const parsed = InputSchema.safeParse(input)
  if (!parsed.success) {
    return []
  }
  return parsed.data.questions.map((question, index) => ({
    id: String(index),
    header: question.header.slice(0, HEADER_LIMIT),
    prompt: question.question,
    options: question.options.map(optionOf),
    multiSelect: question.multiSelect ?? false,
    allowOther: true,
  }))
}

// The agent has recommended when it marked exactly one option of every question
export const recommendationOf = (questions: readonly AskQuestion[]): 'agent' | 'none' =>
  questions.every(
    (question) => question.options.filter((option) => option.recommended).length === 1,
  )
    ? 'agent'
    : 'none'

const labelOf = (question: AskQuestion, id: string | undefined): string | undefined => {
  if (id === undefined) {
    return undefined
  }
  const option = question.options.find((candidate) => candidate.id === id)
  return option === undefined ? id : option.label
}

// The person's own text answers the first question alone: it was written for one question, not for every one of them
const textOf = (answer: AskAnswer, question: AskQuestion, index: number): string | undefined => {
  const { selected } = answer
  if (selected === 'other') {
    return index === 0 ? (answer.otherText ?? '') : undefined
  }
  return labelOf(question, selected[index])
}

// The answers as AskUserQuestion takes them, keyed by the question: the label chosen, or the person's own text
// An ask with several questions is answered with one option id for each, in order
export const answersOf = (
  questions: readonly AskQuestion[],
  answer: AskAnswer,
): Record<string, string> => {
  const pairs = questions.flatMap((question, index) => {
    const text = textOf(answer, question, index)
    return text === undefined ? [] : [[question.prompt, text] as const]
  })
  return Object.fromEntries(pairs)
}
