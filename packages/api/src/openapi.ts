import { OpenApi } from 'effect/http-api'
import { BureauApi } from './api.js'

// The OpenAPI 3.1 document of the API; written to openapi.json at build time and served at /api/v1/openapi.json
export const openApiDocument = (): OpenApi.OpenAPISpec => OpenApi.fromApi(BureauApi)
