export async function screenAddress(
  address: string,
): Promise<boolean> {
  if (!address) return false

  try {
    const resp = await fetch('/api/screen-address', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    })

    if (!resp.ok) {
      return true
    }

    const data = await resp.json()
    return data?.addressIsSuspicious !== false
  }
  catch {
    return true
  }
}
