import { describe, expect, it, vi } from 'vitest'
import { withResource } from './resource.js'

interface Door {
  readonly close: () => Promise<void>
}

async function shut(): Promise<void> {
  await Promise.resolve()
}

async function jam(): Promise<void> {
  await Promise.resolve()
  throw new Error('the door is jammed')
}

interface Opened {
  readonly open: () => Promise<Door>
  // How many times the door was closed
  readonly closed: () => number
}

// A door that is opened and, when it is closed, does what `closing` does
function door(closing: Door['close']): Opened {
  let closes = 0
  const close = async (): Promise<void> => {
    closes += 1
    await closing()
  }
  const open = async (): Promise<Door> => {
    await Promise.resolve()
    return { close }
  }
  return { open, closed: () => closes }
}

async function succeed(): Promise<string> {
  await Promise.resolve()
  return 'result'
}

function failWith(failure: Error): () => Promise<never> {
  return async () => {
    await Promise.resolve()
    throw failure
  }
}

describe(withResource, () => {
  it('hands the result of the work on, after the resource was closed', async () => {
    expect.hasAssertions()
    const { open, closed } = door(shut)
    await expect(withResource(open, succeed)).resolves.toBe('result')
    expect(closed()).toBe(1)
  })

  it('reports a failure to close when the work went well', async () => {
    expect.hasAssertions()
    const { open } = door(jam)
    await expect(withResource(open, succeed)).rejects.toThrow('the door is jammed')
  })

  it('does not run the work when the resource cannot be opened', async () => {
    expect.hasAssertions()
    const work = vi.fn<(resource: Door) => Promise<string>>()
    const locked = failWith(new Error('the door is locked'))
    await expect(withResource(locked, work)).rejects.toThrow('the door is locked')
    expect(work).not.toHaveBeenCalled()
  })
})

describe('withResource when the work fails', () => {
  it('closes the resource and hands the failure on', async () => {
    expect.hasAssertions()
    const failure = new Error('the work failed')
    const { open, closed } = door(shut)
    await expect(withResource(open, failWith(failure))).rejects.toBe(failure)
    expect(closed()).toBe(1)
  })

  it('keeps the failure of the work when closing fails as well', async () => {
    expect.hasAssertions()
    const failure = new Error('the work failed')
    const { open, closed } = door(jam)
    await expect(withResource(open, failWith(failure))).rejects.toBe(failure)
    expect(closed()).toBe(1)
  })
})
