import { describe, expect, it, onTestFinished, vi, type MockInstance } from 'vitest'
import { describeFailure, signalGroup } from './launch.js'

// With process.kill replaced, a wrong pid can never reach a real process or group
const stubProcessKill = (implementation: () => true): MockInstance<typeof process.kill> => {
  const stub = vi.spyOn(process, 'kill').mockImplementation(implementation)
  onTestFinished(() => {
    stub.mockRestore()
  })
  return stub
}

describe(signalGroup, () => {
  it('signals the whole process group of the child', () => {
    const killGroup = stubProcessKill(() => true)
    const kill = vi.fn<() => boolean>(() => true)
    signalGroup({ pid: 4242, kill }, 'SIGTERM')
    expect(killGroup).toHaveBeenCalledExactlyOnceWith(-4242, 'SIGTERM')
    expect(kill).not.toHaveBeenCalled()
  })

  it('falls back to the child when there is no such group', () => {
    stubProcessKill(() => {
      throw new Error('kill ESRCH')
    })
    const kill = vi.fn<() => boolean>(() => true)
    signalGroup({ pid: 4242, kill }, 'SIGKILL')
    expect(kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
  })

  it.each([undefined, 0, 1])('never signals a group for the pid %s', (pid) => {
    const killGroup = stubProcessKill(() => true)
    const kill = vi.fn<() => boolean>(() => true)
    signalGroup({ pid, kill }, 'SIGTERM')
    expect(killGroup).not.toHaveBeenCalled()
    expect(kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
  })
})

describe(describeFailure, () => {
  it('gives a system error as its message', () => {
    const error = Object.assign(new Error('spawn tool ENOENT'), { code: 'ENOENT' })
    expect(describeFailure(error)).toBe('spawn tool ENOENT')
  })

  it.each(['ERR_INVALID_ARG_VALUE', 'ERR_INVALID_ARG_TYPE'])(
    'names an invalid argument by its code %s and leaves the offending value out',
    (code) => {
      const error = Object.assign(new Error("Received 'swordfish'"), { code })
      const text = describeFailure(error)
      expect(text).toContain(code)
      expect(text).not.toContain('swordfish')
    },
  )

  it('gives an error without a code as its message', () => {
    expect(describeFailure(new Error('boom'))).toBe('boom')
  })

  it('turns a thrown value that is no error into text', () => {
    expect(describeFailure('plain')).toBe('plain')
  })
})
