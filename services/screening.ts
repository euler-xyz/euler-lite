import { WALLET_SCREENING_TIMEOUT_MS } from '~/entities/tuning-constants'

export type ScreeningVerdict = 'clear' | 'exit-only' | 'blocked'

export async function screenAddress(
  address: string,
  vpnIsUsed: boolean | null,
): Promise<ScreeningVerdict> {
  if (!address) return 'clear'

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), WALLET_SCREENING_TIMEOUT_MS)

  try {
    const resp = await fetch('/api/internal/screen-address', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, vpnIsUsed }),
      signal: controller.signal,
    })

    if (!resp.ok) {
      return 'blocked'
    }

    const data = await resp.json()
    if (data?.addressIsSuspicious === true && data?.exitOnly === true) return 'exit-only'
    if (data?.addressIsSuspicious === false && data?.exitOnly !== true) return 'clear'
    return 'blocked'
  }
  catch {
    return 'blocked'
  }
  finally {
    clearTimeout(timeout)
  }
}
