import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { OpenApi } from 'effect/http-api'
import { describe, expect, it } from 'vitest'
import { openApiDocument } from './openapi.js'

const committed = fileURLToPath(new URL('../openapi.json', import.meta.url))

// The paths of the groups with one method each, as the document names them
const OPERATIONS: [string, string][] = [
  ['/api/v1/projects', 'get'],
  ['/api/v1/projects', 'post'],
  ['/api/v1/projects/{id}', 'delete'],
  ['/api/v1/sessions/{id}/prompt', 'post'],
  ['/api/v1/asks/{id}/answer', 'post'],
  ['/api/v1/usage/sessions/{id}', 'get'],
  ['/api/v1/workspaces/prune', 'post'],
  ['/api/v1/plugins', 'get'],
  ['/api/v1/providers', 'get'],
]

const METHODS: readonly OpenApi.OpenAPISpecMethodName[] = ['get', 'post', 'put', 'patch', 'delete']

// The method, the path and the status codes each operation of the document declares
const operations = (): { method: string; path: string; statuses: string[] }[] =>
  Object.entries(openApiDocument().paths).flatMap(([path, item]) =>
    METHODS.flatMap((method) => {
      const operation = item[method]
      return operation === undefined
        ? []
        : [{ method, path, statuses: Object.keys(operation.responses) }]
    }),
  )

describe('the OpenAPI document', () => {
  it('is OpenAPI 3.1 with the title and the bearer scheme, and openapi.json is up to date', () => {
    const document = openApiDocument()
    expect(document.openapi).toBe('3.1.0')
    expect(document.info).toMatchObject({ title: 'ByteBureau API', version: 'v1' })
    expect(document.components.securitySchemes).toHaveProperty('bearer')
    expect(document.components.schemas).toHaveProperty('Problem401')
    // The text the build writes, so a stale or reformatted openapi.json fails as well
    expect(readFileSync(committed, 'utf8')).toBe(`${JSON.stringify(document, undefined, 2)}\n`)
  })

  it('lists the health check and the schemas under /api/v1', () => {
    const { paths } = openApiDocument()
    expect(paths).toHaveProperty(['/api/v1/health', 'get'])
    expect(paths).toHaveProperty(['/api/v1/schemas/config.json', 'get'])
    expect(paths).toHaveProperty(['/api/v1/schemas/events.json', 'get'])
  })
})

describe('the OpenAPI document of the resource groups', () => {
  it.each(OPERATIONS)('lists %s with %s', (path, method) => {
    expect(openApiDocument().paths).toHaveProperty([path, method])
  })

  it('declares the 201 response, the problems and the rate limit of registering a project', () => {
    const { paths } = openApiDocument()
    const responses = ['/api/v1/projects', 'post', 'responses']
    expect(paths).toHaveProperty([...responses, '201', 'content', 'application/json'])
    expect(paths).toHaveProperty(
      [...responses, '422', 'content', 'application/problem+json', 'schema', '$ref'],
      '#/components/schemas/Problem422',
    )
    expect(paths).toHaveProperty([...responses, '429'])
    expect(paths).not.toHaveProperty(['/api/v1/projects', 'get', 'responses', '429'])
  })

  it('declares the 429 problem on every mutation and on nothing else', () => {
    expect.hasAssertions()
    for (const { method, path, statuses } of operations()) {
      expect(statuses.includes('429'), `${method} ${path}`).toBe(method !== 'get')
    }
  })

  it('names the schemas of the DTOs and of the problems once each', () => {
    const { schemas } = openApiDocument().components
    expect(schemas).toHaveProperty('Session')
    expect(schemas).toHaveProperty('Project')
    expect(schemas).toHaveProperty('Problem404')
    // A suffix would mean two schemas of one name: the generated client would name its types after it
    expect(Object.keys(schemas).filter((name) => /_\d+$/u.test(name))).toStrictEqual([])
  })
})
