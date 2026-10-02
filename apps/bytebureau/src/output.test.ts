import { describe, expect, it, vi } from 'vitest'
import { colorEnabled, createOutput } from './output.js'

describe(colorEnabled, () => {
  it('turns colour off for --no-color whatever the environment and the terminal say', () => {
    expect(colorEnabled({ FORCE_COLOR: '1' }, true, true)).toBe(false)
  })

  it('turns colour off for NO_COLOR, even with FORCE_COLOR on a TTY', () => {
    expect(colorEnabled({ NO_COLOR: '1', FORCE_COLOR: '1' }, false, true)).toBe(false)
  })

  it('forces colour off a TTY with FORCE_COLOR unless it is 0', () => {
    expect(colorEnabled({ FORCE_COLOR: '1' }, false, false)).toBe(true)
    expect(colorEnabled({ FORCE_COLOR: '0' }, false, false)).toBe(false)
  })

  it('follows the TTY otherwise, as with the default --color', () => {
    expect(colorEnabled({}, false, true)).toBe(true)
    expect(colorEnabled({}, false, false)).toBe(false)
  })
})

describe(createOutput, () => {
  it('prints text and drops records in text mode', () => {
    const log = vi.spyOn(console, 'log').mockReturnValue()
    const output = createOutput({ json: false, color: false })
    output.print('hello')
    output.emit({ command: 'hello' })
    expect(log.mock.calls).toStrictEqual([['hello']])
  })

  it('emits records as JSON and drops text in JSON mode', () => {
    const log = vi.spyOn(console, 'log').mockReturnValue()
    const output = createOutput({ json: true, color: true })
    output.print('hello')
    output.emit({ command: 'hello' })
    expect(log.mock.calls).toStrictEqual([['{"command":"hello"}']])
  })

  it('writes warnings to stderr, as a JSON record in JSON mode', () => {
    const error = vi.spyOn(console, 'error').mockReturnValue()
    createOutput({ json: false, color: false }).warn('careful')
    createOutput({ json: true, color: false }).warn('careful')
    expect(error.mock.calls).toStrictEqual([['careful'], ['{"level":"warn","message":"careful"}']])
  })

  it('colours text only when colour is on', () => {
    expect(createOutput({ json: false, color: true }).colors.bold('x')).not.toBe('x')
    expect(createOutput({ json: false, color: false }).colors.bold('x')).toBe('x')
  })
})
