import { Effect, Option } from 'effect'
import { Headers, HttpTraceContext } from 'effect/http'
import { allowlistEnv } from './env-allowlist.js'

interface EnvRequest {
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly passEnv?: readonly string[] | undefined
}

const traceparent: Effect.Effect<Record<string, string>> = Effect.currentSpan.pipe(
  Effect.option,
  Effect.map(
    Option.flatMap((span) => Headers.get(HttpTraceContext.toHeaders(span), 'traceparent')),
  ),
  Effect.map(
    Option.match({
      onNone: (): Record<string, string> => ({}),
      onSome: (value): Record<string, string> => ({ TRACEPARENT: value }),
    }),
  ),
)

// The daemon's allowlisted variables, then the spec's, then the current span, which wins
const merged = (spec: EnvRequest, trace: Record<string, string>): Record<string, string> => ({
  ...allowlistEnv(process.env, spec.passEnv),
  ...allowlistEnv(spec.env ?? {}, spec.passEnv),
  ...trace,
})

export const childEnv = (spec: EnvRequest): Effect.Effect<Record<string, string>> =>
  traceparent.pipe(Effect.map((trace) => merged(spec, trace)))
