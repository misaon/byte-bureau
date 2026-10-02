import { assert, constantFrom, property, stringMatching } from 'fast-check'
import { describe, expect, it } from 'vitest'
import { TARGETS, artifactName, hostTarget, parseArgs } from './build-binaries.js'

describe(artifactName, () => {
  it('maps every target to the documented file name', () => {
    expect(TARGETS.map((target) => artifactName(target, '0.1.0'))).toStrictEqual([
      'bytebureau-0.1.0-darwin-arm64',
      'bytebureau-0.1.0-darwin-x64',
      'bytebureau-0.1.0-linux-x64',
      'bytebureau-0.1.0-linux-arm64',
      'bytebureau-0.1.0-linux-x64-musl',
      'bytebureau-0.1.0-linux-arm64-musl',
      'bytebureau-0.1.0-windows-x64.exe',
      'bytebureau-0.1.0-windows-arm64.exe',
    ])
  })
})

describe('artifactName properties', () => {
  it('embeds the version verbatim and never produces spaces or path separators', () => {
    expect.hasAssertions()
    assert(
      property(
        constantFrom(...TARGETS),
        stringMatching(/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-z0-9.]{1,10})?$/u),
        (target, version) => {
          const name = artifactName(target, version)
          expect(name).toContain(version)
          expect(name).not.toMatch(/[\s/\\]/u)
          expect(name).toMatch(/^bytebureau-/u)
        },
      ),
    )
  })

  it('hostTarget is one of the eight targets', () => {
    expect(TARGETS).toContain(hostTarget())
  })
})

describe(parseArgs, () => {
  it('defaults to all targets, dist/ and bytecode on', () => {
    expect(parseArgs([], { version: '1.2.3' })).toStrictEqual({
      targets: [...TARGETS],
      outdir: 'dist',
      version: '1.2.3',
      bytecode: true,
    })
  })

  it('accepts a target list, outdir and --no-bytecode', () => {
    expect(
      parseArgs(
        ['--targets', 'bun-linux-x64,bun-linux-arm64', '--outdir', 'out', '--no-bytecode'],
        {
          version: '1.2.3',
        },
      ),
    ).toStrictEqual({
      targets: ['bun-linux-x64', 'bun-linux-arm64'],
      outdir: 'out',
      version: '1.2.3',
      bytecode: false,
    })
  })

  it('rejects unknown targets', () => {
    expect(() => parseArgs(['--targets', 'bun-plan9-x64'], { version: '1.2.3' })).toThrow(
      'unknown target',
    )
  })
})
