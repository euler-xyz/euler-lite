/** Hosted labels use the dedicated image host. Static sources may serve their own images. */
export const resolveLabelLogo = (value: string | undefined, staticBaseUrl?: string): string => {
  if (!value) return ''
  try {
    const base = staticBaseUrl ? new URL(`${staticBaseUrl.replace(/\/+$/, '')}/logo/`) : undefined
    if (!/^https?:\/\//i.test(value) && (!base || !/^[a-zA-Z0-9_-]+\.(svg|png|jpg|jpeg|webp|gif)$/i.test(value))) return ''
    const url = new URL(value, base)
    if (url.username || url.password) return ''
    const hosted = url.protocol === 'https:' && url.hostname === 'token-images.euler.finance' && (!url.port || url.port === '443')
    const authored = base && url.origin === base.origin && ['http:', 'https:'].includes(url.protocol)
    return hosted || authored ? url.href : ''
  }
  catch { return '' }
}
