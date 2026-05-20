export async function screenAddress(
  address: string,
  vpnIsUsed: boolean,
): Promise<boolean> {
  if (!address) return false

  try {
    const resp = await fetch('/api/screen-address', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, vpnIsUsed }),
    })

    const data = await resp.json()
    return Boolean(data?.addressIsSuspicious)
  }
  catch {
    return true
  }
}
