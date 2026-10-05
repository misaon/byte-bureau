#!/usr/bin/env bun
import { readdirSync, rmSync, statSync } from 'node:fs'
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

export interface CompileJob {
  readonly target: Target
  readonly outfile: string
  readonly version: string
  readonly bytecode: boolean
}

export type Compile = (job: CompileJob) => number
export type Outcome = 'bytecode' | 'no bytecode'
type Env = Readonly<Record<string, string | undefined>>

const ROOT = path.join(import.meta.dirname, '..')
const ENTRY = 'apps/bytebureau/src/main.ts'
const STRAY_RUNTIME_SUFFIX = '.bun-build'
const OS_BY_PLATFORM: Readonly<Record<string, string>> = { darwin: 'darwin', win32: 'windows' }

function platformOf(target: Target): string {
  const [, os, arch, libc] = target.split('-')
  const suffix = libc === 'musl' ? '-musl' : ''
  const extension = os === 'windows' ? '.exe' : ''
  return `${os}-${arch}${suffix}${extension}`
}

export function artifactName(target: Target, version: string): string {
  return `bytebureau-${version}-${platformOf(target)}`
}

// The grammar of artifactName for any version, with or without the .map of its source map
const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`
const PLATFORMS = TARGETS.map((target) => platformOf(target).replaceAll('.', String.raw`\.`))
const ARTIFACT = new RegExp(
  String.raw`^bytebureau-${SEMVER}-(?:${PLATFORMS.join('|')})(?:\.map)?$`,
  'u',
)

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

// The binary reads no .env and no bunfig.toml from the directory it starts in
// A bunfig.toml preload would run the code of whoever owns that directory
// A .env could move the data of the kernel
const NO_AUTOLOAD = ['--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig'] as const

export function compileArgs(job: CompileJob): string[] {
  // ESM output: Bun's bytecode default is CommonJS, which rejects the top-level await in main.ts
  const args = ['build', '--compile', ...NO_AUTOLOAD, '--minify', '--sourcemap', '--format=esm']
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
  return args
}

function compile(job: CompileJob): number {
  const result = Bun.spawnSync(['bun', ...compileArgs(job)], {
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return result.exitCode
}

// Under CI a bytecode failure aborts: a release must not mix bytecode and plain binaries
export function compileWithFallback(job: CompileJob, compileJob: Compile, env: Env): Outcome {
  if (compileJob(job) === 0) {
    return job.bytecode ? 'bytecode' : 'no bytecode'
  }
  if (!job.bytecode) {
    throw new Error(`build failed for ${job.target}`)
  }
  if (env['CI'] !== undefined) {
    throw new Error(
      `bytecode compilation failed for ${job.target}; CI builds never drop --bytecode`,
    )
  }
  console.warn(`bytecode compilation failed for ${job.target}; retrying without --bytecode`)
  if (compileJob({ ...job, bytecode: false }) !== 0) {
    throw new Error(`build failed for ${job.target}`)
  }
  return 'no bytecode'
}

function strayRuntimes(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(STRAY_RUNTIME_SUFFIX))
}

// Every compile leaves a runtime copy (.<hash>-00000000.bun-build) in its cwd
export function withoutStrayRuntimes<Result>(dir: string, action: () => Result): Result {
  const before = new Set(strayRuntimes(dir))
  try {
    return action()
  } finally {
    for (const name of strayRuntimes(dir)) {
      if (!before.has(name)) {
        rmSync(path.join(dir, name), { force: true })
      }
    }
  }
}

// The binaries and source maps of earlier builds, of any version: nothing else ever removes them
export function removeStaleArtifacts(outdir: string): string[] {
  const stale = readdirSync(outdir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && ARTIFACT.test(entry.name))
    .map((entry) => entry.name)
    .toSorted()
  for (const name of stale) {
    rmSync(path.join(outdir, name))
  }
  return stale
}

function buildTarget(target: Target, outdir: string, options: BuildOptions): string {
  const name = artifactName(target, options.version)
  const outfile = path.join(outdir, name)
  const job = { target, outfile, version: options.version, bytecode: options.bytecode }
  const outcome = withoutStrayRuntimes(ROOT, () => compileWithFallback(job, compile, process.env))
  const { size } = statSync(outfile)
  console.log(`${name}\t${(size / 1_048_576).toFixed(1)} MB\t${outcome}`)
  return outfile
}

export async function buildAll(options: BuildOptions): Promise<string[]> {
  // Relative to the caller's cwd: dist/ at the root, apps/bytebureau/dist for the app's build script
  const outdir = path.resolve(options.outdir)
  await mkdir(outdir, { recursive: true })
  for (const name of removeStaleArtifacts(outdir)) {
    console.log(`removed ${name}`)
  }
  return options.targets.map((target) => buildTarget(target, outdir, options))
}

/* v8 ignore start */
if (import.meta.main) {
  await buildAll(parseArgs(Bun.argv.slice(2), { version: rootPackage.version }))
}
/* v8 ignore stop */
