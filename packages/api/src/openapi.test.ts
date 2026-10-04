import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { openApiDocument } from './openapi.js'

const committed = fileURLToPath(new URL('../openapi.json', import.meta.url))

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
