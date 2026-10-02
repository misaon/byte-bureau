#!/usr/bin/env bun
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..')

function headingOf(version: string): RegExp {
  const escaped = version.replaceAll('.', String.raw`\.`)
  return new RegExp(`^## v?${escaped}(?:\\s|$)`, 'mu')
}

function bodyOf(section: string): string {
  const afterHeading = section.slice(section.indexOf('\n') + 1)
  const nextHeading = afterHeading.search(/^## /mu)
  return nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading)
}

export function extractReleaseNotes(changelog: string, version: string): string {
  const start = changelog.search(headingOf(version))
  if (start === -1) {
    throw new Error(`CHANGELOG.md has no section for version ${version}`)
  }
  const body = bodyOf(changelog.slice(start)).trim()
  if (body === '') {
    throw new Error(`CHANGELOG.md section for version ${version} is empty`)
  }
  return body
}

if (import.meta.main) {
  const [version, outfile] = Bun.argv.slice(2)
  if (version === undefined || outfile === undefined) {
    console.error('usage: release-notes.ts <version> <outfile>')
    process.exit(1)
  }
  const changelog = await readFile(path.join(ROOT, 'CHANGELOG.md'), 'utf8')
  await writeFile(outfile, `${extractReleaseNotes(changelog, version)}\n`)
}
