/** Hosted labels use Euler image endpoints. Static sources may serve their own images. */
export const resolveLabelLogo = (value: string | undefined, staticBaseUrl?: string): string => {
  if (!value) return ''
  try {
    const base = staticBaseUrl ? new URL(`${staticBaseUrl.replace(/\/+$/, '')}/logo/`) : undefined
    if (!/^https?:\/\//i.test(value) && (!base || !/^[a-zA-Z0-9_-]+\.(svg|png|jpg|jpeg|webp|gif)$/i.test(value))) return ''
    const url = new URL(value, base)
    if (url.username || url.password) return ''
    const hosted = url.protocol === 'https:' && (!url.port || url.port === '443') && (
      url.hostname === 'token-images.euler.finance'
      || (url.hostname === 'v3.euler.finance'
        && /^\/v3\/images\/labels\/[a-zA-Z0-9_-]+$/.test(url.pathname)
        && !url.search && !url.hash)
    )
    const authored = base && url.origin === base.origin && ['http:', 'https:'].includes(url.protocol)
    return hosted || authored ? url.href : ''
  }
  catch { return '' }
}
