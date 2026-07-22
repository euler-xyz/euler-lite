export const PYTH_HERMES_URL = 'https://hermes.pyth.network'

type PythProxyEnv = Record<string, string | undefined>

export function readPythApiKey(env: PythProxyEnv = process.env): string {
  return env.PYTH_API_KEY?.trim() || ''
}

export function isPythProxyConfigured(env: PythProxyEnv = process.env): boolean {
  return readPythApiKey(env).length > 0
}

export function buildPythProxyRequestHeaders(env: PythProxyEnv = process.env): Headers {
  const headers = new Headers({ accept: 'application/json' })
  const apiKey = readPythApiKey(env)
  if (apiKey) headers.set('authorization', `Bearer ${apiKey}`)
  return headers
}
