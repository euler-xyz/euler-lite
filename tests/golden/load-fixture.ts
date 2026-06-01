import { readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SwapQuote } from '@eulerxyz/euler-v2-sdk'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = resolvePath(__dirname, 'fixtures')

const reviveBigints = (_key: string, value: unknown): unknown => {
  if (value && typeof value === 'object' && '$bigint' in value && typeof (value as { $bigint: unknown }).$bigint === 'string') {
    return BigInt((value as { $bigint: string }).$bigint)
  }
  return value
}

export interface SwapFixture<TRequest = unknown> {
  request: TRequest
  quote: SwapQuote
}

/**
 * Loads a JSON fixture saved by `tests/golden/fetch-fixtures.ts`. Reviver
 * converts `{ $bigint: "…" }` markers back to bigint, so request fields like
 * `amount`/`currentDebt` come back in their original numeric form.
 */
export function loadSwapFixture<TRequest = unknown>(name: string): SwapFixture<TRequest> {
  const raw = readFileSync(resolvePath(FIXTURES_DIR, `${name}.json`), 'utf8')
  return JSON.parse(raw, reviveBigints) as SwapFixture<TRequest>
}
