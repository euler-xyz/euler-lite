/** Return an absolute HTTP(S) URL, or undefined for unsafe/relative values. */
export function safeExternalHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : undefined
  }
  catch {
    return undefined
  }
}
