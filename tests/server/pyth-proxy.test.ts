import { describe, expect, it } from 'vitest'
import {
  buildPythProxyRequestHeaders,
  isPythProxyConfigured,
  PYTH_HERMES_URL,
  readPythApiKey,
} from '~/server/utils/pyth-proxy'

describe('pyth proxy configuration', () => {
  it('uses the Pyth Hermes automatic-upgrade endpoint', () => {
    expect(PYTH_HERMES_URL).toBe('https://hermes.pyth.network')
  })

  it('injects the server-side Pyth API key as Bearer authentication', () => {
    const headers = buildPythProxyRequestHeaders({ PYTH_API_KEY: 'pyth-secret' })

    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('authorization')).toBe('Bearer pyth-secret')
  })

  it('trims the configured API key', () => {
    expect(readPythApiKey({ PYTH_API_KEY: '  pyth-secret  ' })).toBe('pyth-secret')
    expect(isPythProxyConfigured({ PYTH_API_KEY: '  pyth-secret  ' })).toBe(true)
  })

  it('treats a blank API key as unconfigured', () => {
    const env = { PYTH_API_KEY: '   ' }

    expect(isPythProxyConfigured(env)).toBe(false)
    expect(buildPythProxyRequestHeaders(env).has('authorization')).toBe(false)
  })

  it('does not read a public API key variable', () => {
    const env = { NUXT_PUBLIC_PYTH_API_KEY: 'public-key' }

    expect(isPythProxyConfigured(env)).toBe(false)
    expect(buildPythProxyRequestHeaders(env).has('authorization')).toBe(false)
  })
})
