import type { EulerLabelEntity, EulerLabelProduct } from '~/entities/euler/labels'

export type ManagerProfileExternalLink = {
  label: string
  url: string
}

const withProtocol = (url: string): string => {
  if (url.startsWith('hhttps://')) return `https://${url.slice('hhttps://'.length)}`
  if (/^https?:\/\//i.test(url)) return url
  return `https://${url}`
}

const cleanHandle = (value: string): string => value.trim().replace(/^@+/, '').replace(/^\/+/, '')

export const getManagerProfileExternalUrl = (url: string): string => withProtocol(url.trim())

const SOCIAL_LINK_LABELS: Record<string, string> = {
  twitter: 'X',
  github: 'GitHub',
  discord: 'Discord',
  telegram: 'Telegram',
  youtube: 'YouTube',
}

const getSocialLinkLabel = (platform: string): string =>
  SOCIAL_LINK_LABELS[platform] ?? platform
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')

export const getManagerProfileSocialUrl = (platform: string, value: string): string => {
  const normalized = value.trim()
  if (!normalized) return ''
  if (/^h?https?:\/\//i.test(normalized)) return withProtocol(normalized)

  const handle = cleanHandle(normalized)
  if (!handle) return ''

  switch (platform) {
    case 'twitter':
      return `https://x.com/${handle}`
    case 'github':
      return `https://github.com/${handle}`
    case 'discord':
      return `https://discord.gg/${handle}`
    case 'telegram':
      return `https://t.me/${handle}`
    case 'youtube':
      return `https://youtube.com/@${handle}`
    default:
      return withProtocol(handle)
  }
}

export const getManagerProfileSocialLinks = (
  entity: EulerLabelEntity,
): ManagerProfileExternalLink[] => {
  const social = entity.social ?? {}
  const links: ManagerProfileExternalLink[] = ([
    entity.url ? { label: 'Website', url: withProtocol(entity.url) } : null,
    ...Object.entries(social).map(([platform, value]) =>
      value
        ? {
            label: getSocialLinkLabel(platform),
            url: getManagerProfileSocialUrl(platform, value),
          }
        : null,
    ),
  ] as Array<ManagerProfileExternalLink | null>).filter((link): link is ManagerProfileExternalLink => Boolean(link?.url))

  const seen = new Set<string>()
  return links.filter((link) => {
    const key = `${link.label}:${link.url}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const getEulerLabelEntityKeys = (product: EulerLabelProduct): string[] => {
  if (Array.isArray(product.entity)) return product.entity
  return product.entity ? [product.entity] : []
}

export const isEulerLabelProductManagedBy = (product: EulerLabelProduct, slug: string): boolean =>
  getEulerLabelEntityKeys(product).includes(slug)

export const getEulerLabelEntitySlug = (
  entities: Record<string, EulerLabelEntity>,
  entity: EulerLabelEntity,
): string => {
  const exact = Object.entries(entities).find(([, value]) => value === entity)
  if (exact) return exact[0]

  const byStableFields = Object.entries(entities).find(([, value]) =>
    value.name === entity.name
    && value.logo === entity.logo
    && value.url === entity.url,
  )
  return byStableFields?.[0] ?? ''
}

export const getEulerLabelEntityDisplayName = (entities: EulerLabelEntity[]): string => {
  if (entities.length === 0) return ''
  if (entities.length === 1) return entities[0].name
  if (entities.length === 2) return `${entities[0].name} & ${entities[1].name}`
  return `${entities[0].name} & others`
}

export const getManagerProfilePath = (slug: string): string => `/managers/${slug}`
