import {
  decodeEventPayload,
  type Ask,
  type AskOption,
  type AskQuestion,
  type EventEnvelope,
  type KernelEventPayload,
  type KernelEventType,
} from '@bytebureau/protocol'

// An envelope as the kernel publishes it; the payload is checked against the type at compile time
export function event<EventType extends KernelEventType>(
  type: EventType,
  payload: KernelEventPayload<EventType>,
  seq = 1,
): EventEnvelope {
  return {
    seq,
    id: '0192f0c8-7b2e-7c3d-9a4b-000000000010',
    ts: '2026-10-02T12:00:00.000Z',
    type,
    sessionId: 's1',
    payload,
  }
}

export function option(id: string, recommended: boolean, description?: string): AskOption {
  return {
    id,
    label: `Option ${id}`,
    recommended,
    evidence: [],
    ...(description === undefined ? {} : { description }),
  }
}

export function question(options: readonly AskOption[], allowOther = false): AskQuestion {
  return {
    id: 'q',
    header: 'Export',
    prompt: 'Should hello() be a named export?',
    options,
    multiSelect: false,
    allowOther,
  }
}

// An ask as it comes off the wire: JSON text keeps null literals out of the CLI sources
export function askOf(
  questions: readonly AskQuestion[],
  recommendationSource: Ask['recommendationSource'] = 'agent',
): Ask {
  const wire = `{"ask":{"id":"a1","sessionId":"s1","turnId":null,"kind":"question","title":"Export style",
    "questions":${JSON.stringify(questions)},"policy":{"onTimeout":"wait","timeout":"30m"},
    "recommendationSource":"${recommendationSource}","status":"pending",
    "createdAt":"2026-10-02T12:00:00.000Z","deadlineAt":null}}`
  return decodeEventPayload('ask.requested', JSON.parse(wire)).ask
}
