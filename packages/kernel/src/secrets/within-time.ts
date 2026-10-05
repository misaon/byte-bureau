// What a call that did not end in time comes to
export const TIMED_OUT = Symbol('timed out')

// The work, or TIMED_OUT once ms have gone by without it; the timer is cleared either way, so nothing holds the process open
export async function withinTime<Value>(
  work: Promise<Value>,
  ms: number,
): Promise<Value | typeof TIMED_OUT> {
  const { promise: timedOut, resolve } = Promise.withResolvers<typeof TIMED_OUT>()
  const timer = setTimeout(() => {
    resolve(TIMED_OUT)
  }, ms)
  try {
    return await Promise.race([work, timedOut])
  } finally {
    clearTimeout(timer)
  }
}
