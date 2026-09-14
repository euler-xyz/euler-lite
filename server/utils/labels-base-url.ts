export const readLabelsSource = (): 'v3' | 'static' => {
  const source = process.env.LABELS_SOURCE?.trim() || 'v3'
  if (source !== 'v3' && source !== 'static') throw new Error('LABELS_SOURCE must be v3 or static')
  return source
}

export function resolveLabelsBaseUrl(): string {
  const value = process.env.STATIC_LABELS_BASE_URL?.trim().replace(/\/+$/, '')
  if (!value) throw new Error('STATIC_LABELS_BASE_URL is required for static labels')
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('STATIC_LABELS_BASE_URL must be an HTTP(S) directory URL without credentials, query or fragment')
  }
  return value
}
