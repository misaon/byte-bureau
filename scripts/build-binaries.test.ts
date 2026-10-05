import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assert, constantFrom, oneof, property, stringMatching } from 'fast-check'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  TARGETS,
  artifactName,
  buildAll,
  compileArgs,
  compileWithFallback,
  hostTarget,
  parseArgs,
  removeStaleArtifacts,
  withoutStrayRuntimes,
  type Compile,
  type CompileJob,
} from './build-binaries.js'

const job: CompileJob = {
  target: 'bun-linux-x64',
  outfile: 'dist/bytebureau',
  version: '1.2.3',
  bytecode: true,
}
const plainJob: CompileJob = { ...job, bytecode: false }

function compileExiting(...codes: number[]): ReturnType<typeof vi.fn<Compile>> {
  const compile = vi.fn<Compile>()
  for (const code of codes) {
    compile.mockReturnValueOnce(code)
  }
  return compile
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bytebureau-build-'))
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

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
    const release = stringMatching(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/u)
    const prerelease = stringMatching(/^\d{1,3}\.\d{1,3}\.\d{1,3}-[a-z0-9.]{1,10}$/u)
    assert(
      property(constantFrom(...TARGETS), oneof(release, prerelease), (target, version) => {
        const name = artifactName(target, version)
        expect(name).toContain(version)
        expect(name).not.toMatch(/[\s/\\]/u)
        expect(name).toMatch(/^bytebureau-/u)
      }),
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

  it('builds only the host target with --host', () => {
    expect(parseArgs(['--host'], { version: '1.2.3' }).targets).toStrictEqual([hostTarget()])
  })

  it('rejects unknown arguments', () => {
    expect(() => parseArgs(['--fast'], { version: '1.2.3' })).toThrow('unknown argument: --fast')
  })
})

describe(compileArgs, () => {
  it('builds executables that autoload neither .env nor bunfig.toml', () => {
    expect.hasAssertions()
    for (const candidate of [job, plainJob]) {
      const args = compileArgs(candidate)
      expect(args).toContain('--no-compile-autoload-dotenv')
      expect(args).toContain('--no-compile-autoload-bunfig')
    }
  })
})

describe(compileWithFallback, () => {
  it('reports bytecode when the first compile succeeds', () => {
    const compile = compileExiting(0)
    expect(compileWithFallback(job, compile, {})).toBe('bytecode')
    expect(compile.mock.calls).toStrictEqual([[job]])
  })

  it('retries exactly once without bytecode after a local bytecode failure', () => {
    vi.spyOn(console, 'warn').mockReturnValue()
    const compile = compileExiting(1, 0)
    expect(compileWithFallback(job, compile, {})).toBe('no bytecode')
    expect(compile.mock.calls).toStrictEqual([[job], [plainJob]])
  })

  it('never retries a build that already has bytecode off', () => {
    const compile = compileExiting(1)
    expect(() => compileWithFallback(plainJob, compile, {})).toThrow(
      'build failed for bun-linux-x64',
    )
    expect(compile.mock.calls).toStrictEqual([[plainJob]])
    expect(compileWithFallback(plainJob, compileExiting(0), {})).toBe('no bytecode')
  })

  it('throws when the retry fails as well', () => {
    vi.spyOn(console, 'warn').mockReturnValue()
    const compile = compileExiting(1, 1)
    expect(() => compileWithFallback(job, compile, {})).toThrow('build failed for bun-linux-x64')
    expect(compile.mock.calls).toStrictEqual([[job], [plainJob]])
  })

  it('aborts instead of retrying when CI is set', () => {
    const compile = compileExiting(1)
    expect(() => compileWithFallback(job, compile, { CI: 'true' })).toThrow(
      'bytecode compilation failed for bun-linux-x64',
    )
    expect(compile.mock.calls).toStrictEqual([[job]])
  })
})

describe(withoutStrayRuntimes, () => {
  it('removes only the .bun-build files created during the action', () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, '.0a1b2c3d4e5f6a7b-00000000.bun-build'), '')
    const result = withoutStrayRuntimes(dir, () => {
      writeFileSync(path.join(dir, '.f7e6d5c4b3a29180-00000000.bun-build'), '')
      writeFileSync(path.join(dir, 'unrelated.txt'), '')
      return 'compiled'
    })
    expect(result).toBe('compiled')
    expect(readdirSync(dir).toSorted()).toStrictEqual([
      '.0a1b2c3d4e5f6a7b-00000000.bun-build',
      'unrelated.txt',
    ])
  })

  it('cleans up when the action throws', () => {
    const dir = tempDir()
    expect(() =>
      withoutStrayRuntimes(dir, () => {
        writeFileSync(path.join(dir, '.f7e6d5c4b3a29180-00000000.bun-build'), '')
        throw new Error('compile crashed')
      }),
    ).toThrow('compile crashed')
    expect(readdirSync(dir)).toStrictEqual([])
  })
})

function touch(dir: string, names: readonly string[]): void {
  for (const name of names) {
    writeFileSync(path.join(dir, name), '')
  }
}

describe(removeStaleArtifacts, () => {
  it('removes the artefacts of earlier builds and leaves the rest', () => {
    const dir = tempDir()
    touch(dir, ['bytebureau-0.0.0-linux-x64', 'bytebureau-0.1.0-darwin-arm64', 'notes.txt'])
    expect(removeStaleArtifacts(dir)).toStrictEqual([
      'bytebureau-0.0.0-linux-x64',
      'bytebureau-0.1.0-darwin-arm64',
    ])
    expect(readdirSync(dir)).toStrictEqual(['notes.txt'])
  })

  it('knows every target and version that artifactName makes, and the map of each', () => {
    const dir = tempDir()
    const names = ['0.1.0', '2.0.0-rc.1'].flatMap((version) =>
      TARGETS.flatMap((target) => [
        artifactName(target, version),
        `${artifactName(target, version)}.map`,
      ]),
    )
    touch(dir, names)
    expect(removeStaleArtifacts(dir)).toStrictEqual(names.toSorted())
    expect(readdirSync(dir)).toStrictEqual([])
  })
})

describe('removeStaleArtifacts and a name that only resembles an artefact', () => {
  it('leaves it, and every directory, where it is', () => {
    const dir = tempDir()
    const kept = [
      'bytebureau-latest-linux-x64',
      'bytebureau-0.1.0-plan9-x64',
      'bytebureau-0.1.0-linux-x64.exe',
      'bytebureau-0.1.0-linux-x64.map.bak',
      'bytebureau-0.1.0-linux-x64.sigstore.json',
      'bytebureau-0.1.0',
      'bytebureau-notes.txt',
      'old-bytebureau-0.1.0-linux-x64',
      'SHA256SUMS',
    ]
    touch(dir, kept)
    mkdirSync(path.join(dir, 'bytebureau-0.1.0-darwin-x64'))
    expect(removeStaleArtifacts(dir)).toStrictEqual([])
    expect(readdirSync(dir)).toHaveLength(kept.length + 1)
  })
})

describe(buildAll, () => {
  it('removes and names the artefacts of earlier builds before it builds', async () => {
    expect.hasAssertions()
    const outdir = path.join(tempDir(), 'out')
    mkdirSync(outdir)
    touch(outdir, ['bytebureau-0.0.0-linux-x64', 'bytebureau-0.0.0-linux-x64.map', 'notes.txt'])
    const log = vi.spyOn(console, 'log').mockReturnValue()
    await expect(
      buildAll({ targets: [], outdir, version: '1.2.3', bytecode: true }),
    ).resolves.toStrictEqual([])
    expect(log.mock.calls).toStrictEqual([
      ['removed bytebureau-0.0.0-linux-x64'],
      ['removed bytebureau-0.0.0-linux-x64.map'],
    ])
    expect(readdirSync(outdir)).toStrictEqual(['notes.txt'])
  })
})
