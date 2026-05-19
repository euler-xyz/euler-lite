import { WALLET_SCREENING_TIMEOUT_MS } from '~/entities/tuning-constants'

export async function screenAddress(
  address: string,
  vpnIsUsed: boolean,
): Promise<boolean> {
  if (!address) return false

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), WALLET_SCREENING_TIMEOUT_MS)

  try {
    const resp = await fetch('/api/screen-address', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, vpnIsUsed }),
      signal: controller.signal,
    })

    const data = await resp.json()
    return Boolean(data?.addressIsSuspicious)
  }
  catch {
    return true
  }
  finally {
    clearTimeout(timeout)
  }
}
