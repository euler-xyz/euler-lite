import { CACHE_TTL_5MIN_MS, WALLET_SCREENING_TIMEOUT_MS } from '~/entities/tuning-constants'

let cached: { value: boolean, timestamp: number } | null = null

// Whether the deployment's edge provider measures VPN usage at all,
// injected by server/plugins/app-config.ts. When absent or false (edges
// without VPN evidence, forks, static deploys) probing would only produce
// noise — the server derives its verdict from edge request headers, and only
// a strict client `true` can add to it (never clear it).
function edgeProvidesVpnEvidence(): boolean {
  if (typeof window === 'undefined') return false
  return window.__APP_CONFIG__?.vpnDetection === true
}

export async function detectVpn(): Promise<boolean> {
  if (!edgeProvidesVpnEvidence()) {
    return false
  }

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
    cached = { value: true, timestamp: Date.now() }
  }
  finally {
    clearTimeout(timeout)
  }

  return cached.value
}

export function resetVpnCache(): void {
  cached = null
}
