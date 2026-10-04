import { describe, expect, it } from 'vitest'
import { isAlive } from './pid-alive.js'

// The largest pid kill accepts, above any a system hands out
const NO_SUCH_PID = 2 ** 31 - 1

describe(isAlive, () => {
  it('finds this process and the first process of the system, which this one may not signal', () => {
    expect([isAlive(process.pid), isAlive(1)]).toStrictEqual([true, true])
  })

  it('finds no process for a pid nobody has, nor for one that is not a process id', () => {
    expect([isAlive(NO_SUCH_PID), isAlive(0), isAlive(-1), isAlive(1.5)]).toStrictEqual([
      false,
      false,
      false,
      false,
    ])
  })
})
