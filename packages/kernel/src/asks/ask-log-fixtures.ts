import type { LogRecord } from '@logtape/logtape'
import type { Effect, Scope } from 'effect'
import { warnings } from '../plugins/log-fixtures.js'

// Everything the asks log, errors included, until the scope of the test closes; the fixture keeps it off stderr
export const logged: Effect.Effect<readonly LogRecord[], never, Scope.Scope> = warnings
