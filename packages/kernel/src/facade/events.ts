import { Stream, type Context } from 'effect'
import { EventLog } from '../events/event-log.js'
import type { Promised, Services } from './promised.js'
import type { Kernel } from './types.js'

// A stream outlives any one call, so it runs on the captured services instead of through the runtime
export const eventsApi = (
  promised: Promised,
  services: Context.Context<Services>,
): Kernel['events'] => ({
  subscribe: (filter) =>
    Stream.toAsyncIterable(
      Stream.unwrap(EventLog.useSync((log) => log.subscribe(filter))).pipe(
        Stream.provideContext(services),
      ),
    ),
  read: promised(EventLog, (log, filter, range) => log.read(filter, range)),
})
