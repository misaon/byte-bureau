import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { answeredIn, newTurn, type Turn } from './session-turns.js'

// A turn whose prompt went out, the agent's answer settling as given
const sent = (answered: Promise<boolean>): Turn => ({ ...newTurn(), answered })
const came = sent(Promise.resolve(true))
const failed = sent(Promise.resolve(false))

describe('whether an agent that died answered its turn', () => {
  it('goes by the turn: answered when its answer came, not when it failed or the prompt never went out', async () => {
    expect.hasAssertions()
    await expect(answeredIn(came)).resolves.toBe(true)
    await expect(answeredIn(failed)).resolves.toBe(false)
    await expect(answeredIn(newTurn())).resolves.toBe(false)
  })

  it('counts an answer read within that second, as one the agent wrote before it died is', async () => {
    expect.hasAssertions()
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const late = Promise.withResolvers<boolean>()
    setTimeout(() => {
      late.resolve(true)
    }, 500)
    const deciding = answeredIn(sent(late.promise))
    await vi.advanceTimersByTimeAsync(500)
    await expect(deciding).resolves.toBe(true)
  })

  it('waits a second for an answer the agent may have written before it died, and no longer', async () => {
    expect.hasAssertions()
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const never = sent(Promise.withResolvers<boolean>().promise)
    const deciding = answeredIn(never)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(deciding).resolves.toBe(false)
  })
})
