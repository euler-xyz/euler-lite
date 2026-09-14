export const MAX_SAFE_CALLS_ID_BYTES = 4_096

export const isSafeCallsId = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value || value.length > MAX_SAFE_CALLS_ID_BYTES) return false
  return new TextEncoder().encode(value).byteLength <= MAX_SAFE_CALLS_ID_BYTES
}
