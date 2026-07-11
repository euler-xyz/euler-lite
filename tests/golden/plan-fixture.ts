import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import type { CanonicalTx } from './normalize'

const PLANS_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), 'plans')

// Regenerate the committed expectations from the current SDK output:
//   npm run test:golden:update
const shouldUpdate = process.env.UPDATE_GOLDEN === '1'

const serialize = (txs: CanonicalTx[]) => `${JSON.stringify(txs, null, 2)}\n`

/**
 * Assert that a normalized SDK tx plan matches its committed golden fixture.
 *
 * The fixture is the reviewed byte-for-byte calldata a wallet would sign for a
 * given operation. In update mode the fixture is (re)written from the current
 * SDK output — the diff is what a reviewer signs off on. Outside update mode a
 * missing fixture is a hard failure rather than a silent self-approval, so the
 * suite can never "pass" by minting its own baseline in CI.
 */
export function expectPlanMatchesGolden(name: string, txs: CanonicalTx[]): void {
  const file = resolvePath(PLANS_DIR, `${name}.json`)

  if (shouldUpdate) {
    mkdirSync(PLANS_DIR, { recursive: true })
    writeFileSync(file, serialize(txs))
    return
  }

  if (!existsSync(file)) {
    throw new Error(
      `Missing golden fixture "${name}". Generate it with \`npm run test:golden:update\` and commit the reviewed result.`,
    )
  }

  const expected = JSON.parse(readFileSync(file, 'utf8')) as CanonicalTx[]
  expect(txs).toEqual(expected)
}
