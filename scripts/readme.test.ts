import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('..', import.meta.url).pathname
const read = (path: string): string => readFileSync(`${root}/${path}`, 'utf8')
const headings = (markdown: string): number =>
  markdown.split('\n').filter((line) => line.startsWith('## ')).length

describe('the README', () => {
  it('stays under 300 lines', () => {
    expect(read('README.md').split('\n').length).toBeLessThanOrEqual(300)
  })

  it('never calls the project open source', () => {
    expect(read('README.md').toLowerCase()).not.toContain('open source')
    expect(read('README.md').toLowerCase()).not.toContain('open-source')
  })

  it('has a Czech mirror with the same section structure', () => {
    expect(headings(read('README.cs.md'))).toBe(headings(read('README.md')))
  })

  it('seeds the changelog with the heading changelogen expects', () => {
    expect(read('CHANGELOG.md')).toMatch(/^# Changelog/u)
  })
})
