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

function firstEnv(env: NodeJS.ProcessEnv, keys: readonly string[]): string {
  for (const key of keys) {
    if (env[key]) return env[key]!
  }
  return ''
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
