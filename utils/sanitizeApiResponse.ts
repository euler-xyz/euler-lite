/**
 * Known root-level keys injected into JSON response bodies by an edge/CDN
 * worker on certain hostnames. These are geo/VPN metadata fields that
 * pollute the intended JSON schema.
 */
const EDGE_INJECTED_KEYS = new Set(['countryCode', 'isProxyOrVpn', 'is_vpn'])

/**
 * Strips CDN-injected geo/VPN metadata keys from a JSON response object.
 * Returns the input unchanged for arrays, primitives, and objects without
 * injected keys. Safe to call in environments where injection doesn't occur.
 */
export function sanitizeApiResponse<T>(data: T): T {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return data
  }

  const obj = data as Record<string, unknown>
  if (!Object.keys(obj).some(k => EDGE_INJECTED_KEYS.has(k))) {
    return data
  }

  const cleaned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (!EDGE_INJECTED_KEYS.has(key)) {
      cleaned[key] = value
    }
  }
  return cleaned as T
}
