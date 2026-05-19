import { CACHE_TTL_5MIN_MS, WALLET_SCREENING_TIMEOUT_MS } from '~/entities/tuning-constants'

let cached: { value: boolean, timestamp: number } | null = null

export async function detectVpn(): Promise<boolean> {
  if (cached !== null && Date.now() - cached.timestamp < CACHE_TTL_5MIN_MS) {
    return cached.value
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), WALLET_SCREENING_TIMEOUT_MS)

  try {
    const resp = await fetch(window.location.origin, { method: 'HEAD', signal: controller.signal })
    const header = resp.headers.get('x-is-vpn')
    cached = { value: header === 'true', timestamp: Date.now() }
  }
  catch {
    cached = { value: false, timestamp: Date.now() }
  }
  finally {
    clearTimeout(timeout)
  }

  return cached.value
}

export function resetVpnCache(): void {
  cached = null
}
