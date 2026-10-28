import { CACHE_TTL_5MIN_MS, WALLET_SCREENING_TIMEOUT_MS } from '~/entities/tuning-constants'

let cached: { value: boolean | null, timestamp: number } | null = null

// Whether the deployment's edge provider measures VPN usage at all,
// injected by server/plugins/app-config.ts. When absent or false (edges
// without VPN evidence, forks, static deploys) probing would only produce
// noise. VPN evidence is audit metadata, not an access verdict; the server
// combines positive client evidence with its own edge request headers.
function edgeProvidesVpnEvidence(): boolean {
  if (typeof window === 'undefined') return false
  return window.__APP_CONFIG__?.vpnDetection === true
}

export async function detectVpn(): Promise<boolean | null> {
  if (!edgeProvidesVpnEvidence()) {
    return null
  }

  if (cached !== null && Date.now() - cached.timestamp < CACHE_TTL_5MIN_MS) {
    return cached.value
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), WALLET_SCREENING_TIMEOUT_MS)

  try {
    const resp = await fetch(window.location.origin, { method: 'HEAD', signal: controller.signal })
    const header = resp.ok ? resp.headers.get('x-is-vpn')?.trim().toLowerCase() : null
    const value = header === 'true' ? true : header === 'false' ? false : null
    cached = { value, timestamp: Date.now() }
  }
  catch {
    cached = { value: null, timestamp: Date.now() }
  }
  finally {
    clearTimeout(timeout)
  }

  return cached.value
}

export function resetVpnCache(): void {
  cached = null
}
