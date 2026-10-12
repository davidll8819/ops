import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'
import { parse } from 'yaml'
import 'reflect-metadata'

vi.mock('@yikart/common', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    selectConfig: (dto: { schema: { parse: (input: unknown) => unknown } }) => {
      const fixture = parse(readFileSync(fileURLToPath(new URL('../config/config.yaml', import.meta.url)), 'utf8'))
      fixture.ai.fouryi = { baseUrl: 'https://fouryi.example', apiKey: '', timeout: 300000 }
      return dto.schema.parse(fixture)
    },
  }
})

// Unit tests do not connect to MongoDB; Vite does not emit Nest property metadata.
vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const original = await importOriginal<typeof import('@nestjs/mongoose')>()
  return {
    ...original,
    Prop: (options: Record<string, unknown> = {}) => original.Prop({ type: Object, ...options }),
  }
})
