import { parsePublicImagesBaseUrl } from '~/utils/v3-images'

/** Accept Euler image endpoints, configured hosted origins, or the static source's images. */
export const resolveLabelLogo = (value: string | undefined, staticBaseUrl?: string, trustedOrigins: readonly string[] = [], imagesBaseUrl?: string): string => {
  if (!value) return ''
  try {
    const base = staticBaseUrl ? new URL(`${staticBaseUrl.replace(/\/+$/, '')}/logo/`) : undefined
    if (!/^https?:\/\//i.test(value) && (!base || !/^[a-zA-Z0-9_-]+\.(svg|png|jpg|jpeg|webp|gif)$/i.test(value))) return ''
    const url = new URL(value, base)
    if (url.username || url.password) return ''
    const imagesBase = parsePublicImagesBaseUrl(imagesBaseUrl)
    const labelBase = imagesBase ? `${imagesBase}/labels/` : ''
    const secure = url.protocol === 'https:' && (!url.port || url.port === '443')
    if (url.hostname === 'token-images.euler.finance') {
      const label = url.pathname.match(/^\/labels\/([a-zA-Z0-9_-]+)(?:\.(?:svg|png|jpg|jpeg|webp|gif))?$/i)
      return secure && label && labelBase ? `${labelBase}${label[1]}` : ''
    }
    const hosted = (secure && url.hostname === 'v3.euler.finance'
      && /^\/v3\/images\/labels\/[a-zA-Z0-9_-]+$/.test(url.pathname)
      && !url.search && !url.hash)
    || (labelBase && url.href.startsWith(labelBase) && /^[a-zA-Z0-9_-]+$/.test(url.href.slice(labelBase.length)))
    const authored = base && url.origin === base.origin && ['http:', 'https:'].includes(url.protocol)
    const configured = ['http:', 'https:'].includes(url.protocol) && trustedOrigins.includes(url.origin)
    return hosted || authored || configured ? url.href : ''
  }
  catch { return '' }
}
