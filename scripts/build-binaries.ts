#!/usr/bin/env bun
import { statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import rootPackage from '../package.json' with { type: 'json' }

export const TARGETS = [
  'bun-darwin-arm64',
  'bun-darwin-x64',
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-linux-x64-musl',
  'bun-linux-arm64-musl',
  'bun-windows-x64',
  'bun-windows-arm64',
] as const

export type Target = (typeof TARGETS)[number]

export interface BuildOptions {
  readonly targets: Target[]
  readonly outdir: string
  readonly version: string
  readonly bytecode: boolean
}

type Flags = Omit<BuildOptions, 'version'>

interface CompileJob {
  readonly target: Target
  readonly outfile: string
  readonly version: string
  readonly bytecode: boolean
}

const ROOT = path.join(import.meta.dirname, '..')
const ENTRY = 'apps/bytebureau/src/main.ts'
const OS_BY_PLATFORM: Readonly<Record<string, string>> = { darwin: 'darwin', win32: 'windows' }

export function artifactName(target: Target, version: string): string {
  const [, os, arch, libc] = target.split('-')
  const suffix = libc === 'musl' ? '-musl' : ''
  const extension = os === 'windows' ? '.exe' : ''
  return `bytebureau-${version}-${os}-${arch}${suffix}${extension}`
}

function isTarget(value: string): value is Target {
  return (TARGETS as readonly string[]).includes(value)
}

export function hostTarget(): Target {
  const os = OS_BY_PLATFORM[process.platform] ?? 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const candidate = `bun-${os}-${arch}`
  if (!isTarget(candidate)) {
    throw new Error(`unsupported host platform: ${candidate}`)
  }
  return candidate
}

function parseTargets(list: string): Target[] {
  return list.split(',').map((value) => {
    const trimmed = value.trim()
    if (!isTarget(trimmed)) {
      throw new Error(`unknown target: ${trimmed}`)
    }
    return trimmed
  })
}

// A flag that takes a value consumes it from the arguments that follow it
function applyFlag(flags: Flags, arg: string, rest: string[]): Flags {
  switch (arg) {
    case '--host': {
      return { ...flags, targets: [hostTarget()] }
    }
    case '--targets': {
      return { ...flags, targets: parseTargets(rest.shift() ?? '') }
    }
    case '--outdir': {
      return { ...flags, outdir: rest.shift() ?? flags.outdir }
    }
    case '--no-bytecode': {
      return { ...flags, bytecode: false }
    }
    default: {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
}

export function parseArgs(argv: readonly string[], defaults: { version: string }): BuildOptions {
  let flags: Flags = { targets: [...TARGETS], outdir: 'dist', bytecode: true }
  const rest = [...argv]
  for (let arg = rest.shift(); arg !== undefined; arg = rest.shift()) {
    flags = applyFlag(flags, arg, rest)
  }
  return { ...flags, version: defaults.version }
}

function compile(job: CompileJob): number {
  // ESM output: Bun's bytecode default is CommonJS, which rejects the top-level await in main.ts
  const args = ['build', '--compile', '--minify', '--sourcemap', '--format=esm']
  if (job.bytecode) {
    args.push('--bytecode')
  }
  args.push(
    `--target=${job.target}`,
    '--define',
    `BYTEBUREAU_VERSION=${JSON.stringify(job.version)}`,
    ENTRY,
    '--outfile',
    job.outfile,
  )
  const result = Bun.spawnSync(['bun', ...args], {
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return result.exitCode
}

function compileWithFallback(job: CompileJob): number {
  const exitCode = compile(job)
  if (exitCode === 0 || !job.bytecode) {
    return exitCode
  }
  console.warn(`bytecode compilation failed for ${job.target}; retrying without --bytecode`)
  return compile({ ...job, bytecode: false })
}

function buildTarget(target: Target, outdir: string, options: BuildOptions): string {
  const name = artifactName(target, options.version)
  const outfile = path.join(outdir, name)
  const exitCode = compileWithFallback({
    target,
    outfile,
    version: options.version,
    bytecode: options.bytecode,
  })
  if (exitCode !== 0) {
    throw new Error(`build failed for ${target}`)
  }
  const { size } = statSync(outfile)
  console.log(`${name}\t${(size / 1_048_576).toFixed(1)} MB`)
  return outfile
}

export async function buildAll(options: BuildOptions): Promise<string[]> {
  // Relative to the caller's cwd: dist/ at the root, apps/bytebureau/dist for the app's build script
  const outdir = path.resolve(options.outdir)
  await mkdir(outdir, { recursive: true })
  return options.targets.map((target) => buildTarget(target, outdir, options))
}

if (import.meta.main) {
  await buildAll(parseArgs(Bun.argv.slice(2), { version: rootPackage.version }))
}
