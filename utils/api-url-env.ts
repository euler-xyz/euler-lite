export const DEFAULT_V3_API_URL = 'https://v3.euler.finance'
export const V3_API_PROXY_URL = '/api/v3'

const V3_API_ENV_KEYS = [
  'V3_API_URL',
  'EULER_SDK_V3_API_URL',
  'NUXT_PUBLIC_V3_API_URL',
] as const

const V3_API_KEY_ENV_KEYS = [
  'V3_API_KEY',
  'EULER_SDK_V3_API_KEY',
  'EULER_V3_API_KEY',
] as const

const SERVER_VAULT_CACHE_SOURCE_ENV_KEYS = [
  'SERVER_VAULT_CACHE_SOURCE',
] as const

const BROWSER_VAULT_SOURCE_ENV_KEYS = [
  'NUXT_PUBLIC_BROWSER_VAULT_SOURCE',
  'BROWSER_VAULT_SOURCE',
] as const

const DISABLE_SERVER_VAULT_CACHE_ENV_KEYS = [
  'DISABLE_SERVER_VAULT_CACHE',
] as const

/**
 * Adapter chain used to satisfy a vault read.
 *
 *   - `fallback` — V3 primary, on-chain secondary (SDK default).
 *   - `onchain`  — direct on-chain reads only.
 *   - `v3`       — V3 only; fails to build when no V3 endpoint is configured.
 *
 * Used by both the server snapshot builder (`SERVER_VAULT_CACHE_SOURCE`)
 * and the browser's "fast" SDK instance (`NUXT_PUBLIC_BROWSER_VAULT_SOURCE`).
 * The plan-time / "fresh" client SDK is always on-chain and ignores this.
 */
export type VaultDataSource = 'fallback' | 'onchain' | 'v3'

export const DEFAULT_VAULT_DATA_SOURCE: VaultDataSource = 'fallback'

const VAULT_DATA_SOURCES: readonly VaultDataSource[] = ['fallback', 'onchain', 'v3'] as const

function firstEnv(env: NodeJS.ProcessEnv, keys: readonly string[]): string {
  for (const key of keys) {
    if (env[key]) return env[key]!
  }
  return ''
}

function readVaultDataSource(
  env: NodeJS.ProcessEnv,
  envKeys: readonly string[],
  label: string,
): VaultDataSource {
  const raw = firstEnv(env, envKeys).trim().toLowerCase()
  if (!raw) return DEFAULT_VAULT_DATA_SOURCE
  if ((VAULT_DATA_SOURCES as readonly string[]).includes(raw)) return raw as VaultDataSource
  console.warn(
    `[euler-lite] ${label}="${raw}" is not one of ${VAULT_DATA_SOURCES.join(' | ')}; falling back to "${DEFAULT_VAULT_DATA_SOURCE}".`,
  )
  return DEFAULT_VAULT_DATA_SOURCE
}

function isTruthyEnv(value: string): boolean {
  const v = value.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

export function readV3ApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  return firstEnv(env, V3_API_ENV_KEYS)
}

export function readV3ApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return firstEnv(env, V3_API_KEY_ENV_KEYS)
}

export function readResolvedV3ApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  return readV3ApiUrl(env).trim().replace(/\/+$/, '') || DEFAULT_V3_API_URL
}

/** Adapter chain the server snapshot builder uses. */
export function readServerVaultCacheSource(env: NodeJS.ProcessEnv = process.env): VaultDataSource {
  return readVaultDataSource(env, SERVER_VAULT_CACHE_SOURCE_ENV_KEYS, 'SERVER_VAULT_CACHE_SOURCE')
}

/** Adapter chain the browser's "fast" SDK instance uses. */
export function readBrowserVaultSource(env: NodeJS.ProcessEnv = process.env): VaultDataSource {
  return readVaultDataSource(env, BROWSER_VAULT_SOURCE_ENV_KEYS, 'NUXT_PUBLIC_BROWSER_VAULT_SOURCE')
}

/**
 * When set, the warm-cache plugin skips the vault snapshot cycle and the
 * `/api/vaults` endpoint short-circuits with 503. The browser's snapshot
 * hydrate falls through to the normal RPC pipeline.
 */
export function readDisableServerVaultCache(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = firstEnv(env, DISABLE_SERVER_VAULT_CACHE_ENV_KEYS)
  return !!raw && isTruthyEnv(raw)
}

/**
 * Emit a one-time warning when a configured source needs the V3 backend
 * but no `V3_API_URL` (or alias) is set:
 *
 *   - `source === 'v3'`       → SDK build throws on missing V3.
 *   - `source === 'fallback'` → SDK silently sets `disableV3: true` and
 *                                degrades to on-chain. Surprising in dev.
 *
 * Called from boot-time code paths (warm-cache plugin, app-config plugin).
 * Safe to call multiple times — the message is logged each time so the
 * caller's log context makes the origin obvious.
 */
export function warnIfVaultSourceNeedsV3(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (readV3ApiUrl(env)) return
  const serverSource = readServerVaultCacheSource(env)
  const browserSource = readBrowserVaultSource(env)
  const offenders: string[] = []
  if (serverSource !== 'onchain') offenders.push(`SERVER_VAULT_CACHE_SOURCE="${serverSource}"`)
  if (browserSource !== 'onchain') offenders.push(`NUXT_PUBLIC_BROWSER_VAULT_SOURCE="${browserSource}"`)
  if (offenders.length === 0) return
  console.warn(
    `[euler-lite] V3_API_URL is not set but ${offenders.join(' and ')} needs V3. `
    + `Set V3_API_URL/EULER_SDK_V3_API_URL, or pin the source(s) to "onchain".`,
  )
}
