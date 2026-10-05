import { lstatSync, readlinkSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  RequestError,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk'

const LINK_HOPS = 40
// A backslash is a separator only on Windows; elsewhere it may be part of a name
const SEPARATORS = path.sep === '/' ? '/' : /[\\/]/u

// A walk along a path: the real directory reached so far, the parts still to take, the links followed
interface Walk {
  current: string
  readonly pending: string[]
  hops: number
}

// Where a symlink points, when the path is one
const linkOf = (target: string): string | undefined => {
  try {
    return lstatSync(target).isSymbolicLink() ? readlinkSync(target) : undefined
  } catch {
    return undefined
  }
}

const partsOf = (target: string): string[] =>
  target.slice(path.parse(target).root.length).split(SEPARATORS)

// A link puts the parts it points at before the rest, from its own directory or from the root; anything else, there or not yet, is entered
const enter = (walk: Walk, next: string): void => {
  const link = linkOf(next)
  if (link === undefined) {
    walk.current = next
    return
  }
  walk.hops += 1
  walk.current = path.isAbsolute(link) ? path.parse(link).root : walk.current
  walk.pending.unshift(...partsOf(link))
}

// .. climbs from the real directory, which is where a link led and not where the path's text says
const step = (walk: Walk, part: string): void => {
  if (part === '..') {
    walk.current = path.dirname(walk.current)
  } else if (part !== '' && part !== '.') {
    enter(walk, path.join(walk.current, part))
  }
}

// The real path of a target that may not exist yet, resolved part by part as the file system does
// Node's and Bun's realpath take .. out before they follow a link, which a link/.. would slip past; undefined for links without end
const realOf = (target: string): string | undefined => {
  const walk: Walk = { current: path.parse(target).root, pending: partsOf(target), hops: 0 }
  let part = walk.pending.shift()
  while (part !== undefined && walk.hops <= LINK_HOPS) {
    step(walk, part)
    part = walk.pending.shift()
  }
  return walk.hops > LINK_HOPS ? undefined : walk.current
}

const isWithin = (root: string, real: string): boolean => {
  const relative = path.relative(root, real)
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

// The target as the file system resolves it, symlinks and .. alike, when that is inside the workspace
// A relative target is taken from the workspace; no part of the path is normalised before the file system resolves it
const realInside = (workspace: string, target: string): string | undefined => {
  const root = realOf(path.resolve(workspace))
  if (root === undefined) {
    return undefined
  }
  const real = realOf(path.isAbsolute(target) ? target : `${root}${path.sep}${target}`)
  return real !== undefined && isWithin(root, real) ? real : undefined
}

export const insideWorkspace = (workspace: string, target: string): boolean =>
  realInside(workspace, target) !== undefined

// The real path a request may use; anything outside the workspace is refused as invalid params
export const confined = (workspace: string, target: string): string => {
  const real = realInside(workspace, target)
  if (real === undefined) {
    throw RequestError.invalidParams({ path: target }, `${target} is outside the workspace`)
  }
  return real
}

// The lines from `line` (1-based), as many as `limit`, when the agent asks for a part
const partOf = (content: string, { line, limit }: ReadTextFileRequest): string => {
  if (typeof line !== 'number' && typeof limit !== 'number') {
    return content
  }
  const start = Math.max((line ?? 1) - 1, 0)
  const end = typeof limit === 'number' ? start + limit : undefined
  return content.split('\n').slice(start, end).join('\n')
}

export const readTextFile = async (
  workspace: string,
  params: ReadTextFileRequest,
): Promise<ReadTextFileResponse> => {
  const content = await readFile(confined(workspace, params.path), 'utf8')
  return { content: partOf(content, params) }
}

// The directories a new file needs are made, all of them inside the workspace
export const writeTextFile = async (
  workspace: string,
  params: WriteTextFileRequest,
): Promise<WriteTextFileResponse> => {
  const target = confined(workspace, params.path)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, params.content, 'utf8')
  return {}
}
