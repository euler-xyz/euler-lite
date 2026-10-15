import { readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAddress, type Address } from 'viem'
import type { SwapQuote } from '@eulerxyz/euler-v2-sdk'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = resolvePath(__dirname, 'fixtures')

export const DEPLOYMENT_FIXTURE = 'deployment'

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

export interface GoldenDeployment {
  evc: Address
  permit2: Address
  swapper: Address
  swapVerifier: Address
  accountLens: Address
}

/**
 * Loads the Euler deployment the swap-quote fixtures were fetched against. The
 * SDK rejects a quote whose swapper or verifier differs from the deployment, so
 * the addresses must come from the same `fetch-fixtures.ts` run as the quotes.
 */
export function loadDeploymentFixture(chainId: number): GoldenDeployment {
  const file = `${DEPLOYMENT_FIXTURE}.json`
  const raw = JSON.parse(readFileSync(resolvePath(FIXTURES_DIR, file), 'utf8')) as Record<string, unknown>
  if (raw.chainId !== chainId) {
    throw new Error(`${file} is for chain ${String(raw.chainId)}, expected ${chainId}. Regenerate it with \`npm run test:golden:fetch-fixtures\`.`)
  }
  const address = (key: keyof GoldenDeployment) => getAddress(String(raw[key]))
  return {
    evc: address('evc'),
    permit2: address('permit2'),
    swapper: address('swapper'),
    swapVerifier: address('swapVerifier'),
    accountLens: address('accountLens'),
  }
}
