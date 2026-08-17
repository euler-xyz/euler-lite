/**
 * Refreshes the committed build-time snapshots under server/assets/manifests/.
 *
 * These are the last-resort fallbacks served by /api/internal/euler-chains
 * and /api/internal/abis/[contract] when the euler-interfaces upstream is
 * unreachable and no cached copy exists (cold start during an outage).
 * Staleness is acceptable there — the runtime fetch supplies fresh data on
 * every healthy path — so run this occasionally, or whenever a new chain or
 * lens deployment lands in euler-interfaces:
 *
 *   npm run snapshots:update
 *
 * The contract list must match ABI_SNAPSHOTS in
 * server/api/internal/abis/[contract].get.ts.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BRANCH = process.env.EULER_SDK_EULER_INTERFACES_BRANCH?.trim() || 'master'
const BASE_URL = `https://raw.githubusercontent.com/euler-xyz/euler-interfaces/refs/heads/${BRANCH}`
const ABI_CONTRACTS = ['AccountLens', 'UtilsLens', 'VaultLens']

const manifestsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'server',
  'assets',
  'manifests',
)

async function fetchJsonArray(path) {
  const url = `${BASE_URL}/${path}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}`)
  }
  const data = await response.json()
  if (!Array.isArray(data)) {
    throw new Error(`${url} returned a non-array payload`)
  }
  return data
}

async function writeSnapshot(relativePath, data) {
  const target = join(manifestsDir, relativePath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(data, null, 2)}\n`)
  console.log(`updated ${relativePath} (${data.length} entries)`)
}

const eulerChains = await fetchJsonArray('EulerChains.json')
await writeSnapshot('EulerChains.json', eulerChains)

for (const contract of ABI_CONTRACTS) {
  const abi = await fetchJsonArray(`abis/${contract}.json`)
  await writeSnapshot(join('abis', `${contract}.json`), abi)
}
