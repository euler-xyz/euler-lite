const V3_API_ENV_KEYS = [
  'V3_API_URL',
  'EULER_SDK_V3_API_URL',
  'NUXT_PUBLIC_V3_API_URL',
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
