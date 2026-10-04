#!/usr/bin/env bun
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { openApiDocument } from '../src/openapi.js'

writeFileSync(
  path.join(import.meta.dirname, '..', 'openapi.json'),
  `${JSON.stringify(openApiDocument(), undefined, 2)}\n`,
)
