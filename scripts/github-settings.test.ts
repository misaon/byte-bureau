import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import commitlint from '../commitlint.config.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (file: string): string => readFileSync(path.join(root, file), 'utf8')
const yamlAt = (file: string): unknown => parse(read(file))
const jsonAt = (file: string): unknown => JSON.parse(read(file))
const MATRIX_NAME = /\$\{\{\s*matrix\.(?<axis>\w+)\s*\}\}/u

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function at(value: unknown, ...keys: readonly string[]): unknown {
  let current = value
  for (const key of keys) {
    current = isRecord(current) ? current[key] : undefined
  }
  return current
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function strings(value: unknown): string[] {
  return list(value).filter((item) => typeof item === 'string')
}

// Block scalars (scopes: |) and comma lists (exempt-issue-labels) both become one entry per item
function items(value: unknown, separator: string): string[] {
  return typeof value === 'string'
    ? value
        .split(separator)
        .map((item) => item.trim())
        .filter((item) => item !== '')
    : []
}

function stepUsing(workflow: string, job: string, action: string): unknown {
  return list(at(yamlAt(workflow), 'jobs', job, 'steps')).find((step) => {
    const uses = at(step, 'uses')
    return typeof uses === 'string' && uses.includes(action)
  })
}

// A matrix job reports one check per value, e.g. unit (${{ matrix.os }}) -> unit (ubuntu-24.04)
function checkNames(workflow: string): string[] {
  const jobs = at(yamlAt(workflow), 'jobs')
  return Object.entries(isRecord(jobs) ? jobs : {}).flatMap(([id, job]) => {
    const name = at(job, 'name')
    const label = typeof name === 'string' ? name : id
    const match = MATRIX_NAME.exec(label)
    const axis = at(match === null ? undefined : match.groups, 'axis')
    return match === null || typeof axis !== 'string'
      ? [label]
      : strings(at(job, 'strategy', 'matrix', axis)).map((value) => label.replace(match[0], value))
  })
}

// The scope list is computed by commitlint.config.ts itself, so new workspace directories count too
function commitlintRule(name: string): string[] {
  return strings(list(at(commitlint.rules, name))[2])
}

const definedLabels: ReadonlySet<string> = new Set(
  read('scripts/repo-settings/labels.txt')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split('|')[0] ?? ''),
)

function referencedLabels(): string[] {
  const stale = at(stepUsing('.github/workflows/stale.yml', 'stale', 'actions/stale@'), 'with')
  const labeler = yamlAt('.github/labeler.yml')
  const issueForms = readdirSync(path.join(root, '.github/ISSUE_TEMPLATE')).filter(
    (name) => name.endsWith('.yml') && name !== 'config.yml',
  )
  return [
    ...Object.keys(isRecord(labeler) ? labeler : {}),
    ...issueForms.flatMap((name) =>
      strings(at(yamlAt(`.github/ISSUE_TEMPLATE/${name}`), 'labels')),
    ),
    ...['exempt-issue-labels', 'exempt-pr-labels', 'stale-issue-label', 'stale-pr-label'].flatMap(
      (input) => items(at(stale, input), ','),
    ),
    ...strings(at(jsonAt('renovate.json'), 'labels')),
  ]
}

function requiredContexts(): unknown[] {
  const rule = list(at(jsonAt('scripts/repo-settings/ruleset-main.json'), 'rules')).find(
    (candidate) => at(candidate, 'type') === 'required_status_checks',
  )
  return list(at(rule, 'parameters', 'required_status_checks')).map((check) => at(check, 'context'))
}

describe('repository settings parity', () => {
  it('defines every label that .github and renovate.json refer to', () => {
    const referenced = referencedLabels()
    expect(referenced).toContain('status: stale')
    expect(referenced.filter((label) => !definedLabels.has(label))).toStrictEqual([])
  })

  it('requires only status checks that ci.yml and semantic-pr.yml report', () => {
    const contexts = requiredContexts()
    const checks = [
      ...checkNames('.github/workflows/ci.yml'),
      ...checkNames('.github/workflows/semantic-pr.yml'),
    ]
    expect(contexts).toContain('unit (ubuntu-24.04-arm)')
    expect(checks).toStrictEqual(expect.arrayContaining(contexts))
  })

  it('accepts the same scopes and types in pull request titles as commitlint does', () => {
    const semanticPr = at(
      stepUsing(
        '.github/workflows/semantic-pr.yml',
        'semantic-pr',
        '/action-semantic-pull-request@',
      ),
      'with',
    )
    const scopes = commitlintRule('scope-enum')
    expect(scopes).toContain('bytebureau')
    expect(items(at(semanticPr, 'scopes'), '\n').toSorted()).toStrictEqual(scopes.toSorted())
    expect(items(at(semanticPr, 'types'), '\n').toSorted()).toStrictEqual(
      commitlintRule('type-enum').toSorted(),
    )
  })
})
