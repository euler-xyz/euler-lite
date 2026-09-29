import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EulerLabelsFileData } from '@eulerxyz/euler-v2-sdk/public-labels'
import { fetchWithTimeout, withWallClock } from './fetchWithTimeout'
import { resolveLabelsBaseUrl } from './labels-base-url'
import { validateNode, validateStaticGeo } from './static-labels-validation'
import { logger } from './logger'
import { normalizeLabelsBundle, type StaticLabelsBundle } from '~/utils/public-labels'

const cache = new Map<string, StaticLabelsBundle>()
const pending = new Map<string, Promise<StaticLabelsBundle>>()

const validate = (bundle: StaticLabelsBundle, chainId: number): StaticLabelsBundle => {
  const files = bundle.files
  if (!files || !Number.isFinite(bundle.fetchedAt) || bundle.fetchedAt <= 0) throw new Error('Invalid static labels checkpoint')
  for (const key of ['products', 'entities'] as const) {
    if (!files[key] || typeof files[key] !== 'object' || Array.isArray(files[key])) throw new Error(`Invalid static ${key}`)
  }
  for (const key of ['points', 'earnVaults', 'assets'] as const) {
    if (!Array.isArray(files[key])) throw new Error(`Invalid static ${key}`)
  }
  validateNode(files, 'static-labels')
  validateStaticGeo(files)
  for (const rule of files.assets) {
    if (!rule || typeof rule !== 'object' || !(rule.address || rule.symbols?.length || rule.names?.length || rule.symbolRegex || rule.nameRegex)) throw new Error('Static asset rule requires a matcher')
  }
  normalizeLabelsBundle(chainId, bundle)
  return bundle
}

/** Missing documents use empty collections; failed refreshes retain the entire last-known-good snapshot. */
export const getStaticLabelsBundle = (chainId: number, force = false): Promise<StaticLabelsBundle> => {
  const base = resolveLabelsBaseUrl()
  const key = `${base}:${chainId}`
  const existing = pending.get(key)
  if (existing) return existing
  const hit = cache.get(key)
  if (!force && hit && Date.now() - hit.fetchedAt < 300_000) return Promise.resolve(hit)
  const directory = process.env.GEO_POLICY_CACHE_DIR || '.data/geo-policies'
  const file = join(directory, `static-${createHash('sha256').update(key).digest('hex')}.json`)
  const task = (async () => {
    let lastGood = hit
    if (!lastGood) {
      try {
        const saved = JSON.parse(await readFile(file, 'utf8')) as StaticLabelsBundle
        if (saved.source !== 'static' || saved.logoBaseUrl !== base) throw new Error('Static labels checkpoint source mismatch')
        lastGood = validate(saved, chainId)
      }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn({ ctx: 'static-labels', chainId, err }, 'checkpoint unavailable')
      }
    }
    try {
      const bundle = await withWallClock(async () => {
        const read = async (scope: number | 'all', name: string) => {
          const response = await fetchWithTimeout(`${base}/${scope}/${name}.json`)
          // Match the labels file contract, including S3/CDN missing-key 403 responses.
          if (response.status === 404 || response.status === 403) return name === 'products' || name === 'entities' ? {} : []
          if (!response.ok) throw new Error(`Static labels ${scope}/${name}: HTTP ${response.status}`)
          return response.json()
        }
        const [products, entities, points, earnVaults, chainAssets, globalAssets] = await Promise.all([
          read(chainId, 'products'), read(chainId, 'entities'), read(chainId, 'points'),
          read(chainId, 'earn-vaults'), read(chainId, 'assets'), read('all', 'assets'),
        ])
        if (!Array.isArray(chainAssets) || !Array.isArray(globalAssets)) throw new Error('Static asset rules must be arrays')
        const files = { products, entities, points, earnVaults, assets: [...chainAssets, ...globalAssets] } as EulerLabelsFileData
        const version = createHash('sha256').update(JSON.stringify(files)).digest('hex')
        return validate({ source: 'static', version, files, logoBaseUrl: base, fetchedAt: Date.now() }, chainId)
      }, 30_000, `static-labels chain=${chainId}`)
      cache.set(key, bundle)
      try {
        await mkdir(directory, { recursive: true })
        const temporary = `${file}.${randomUUID()}.tmp`
        await writeFile(temporary, JSON.stringify(bundle), { mode: 0o600 })
        await rename(temporary, file)
      }
      catch (err) { logger.warn({ ctx: 'static-labels', chainId, err }, 'checkpoint write failed') }
      return bundle
    }
    catch (err) {
      if (!lastGood) throw err
      cache.set(key, lastGood)
      logger.warn({ ctx: 'static-labels', chainId, ageMs: Date.now() - lastGood.fetchedAt, err }, 'using last-known-good static labels')
      return lastGood
    }
  })().finally(() => { pending.delete(key) })
  pending.set(key, task)
  return task
}
