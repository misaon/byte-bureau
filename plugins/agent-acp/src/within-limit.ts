// The value of the work, or null once the limit is over; the timer does not outlive the race
export const withinLimit = async <Value>(
  work: Promise<Value>,
  limitMs: number,
): Promise<Value | null> => {
  const { promise, resolve } = Promise.withResolvers<null>()
  const timer = setTimeout(() => {
    resolve(null)
  }, limitMs)
  try {
    const value = await Promise.race([work, promise])
    return value
  } finally {
    clearTimeout(timer)
  }
}
