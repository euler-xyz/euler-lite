import type { EulerLabelEntity, EulerLabelProduct } from '~/entities/euler/labels'

export type ManagerProfileExternalLink = {
  label: string
  url: string
}

export type ManagerProfileAddressEntry = {
  address: string
  label: string
}

const withProtocol = (url: string): string => {
  if (url.startsWith('hhttps://')) return `https://${url.slice('hhttps://'.length)}`
  if (/^https?:\/\//i.test(url)) return url
  return `https://${url}`
}

const cleanHandle = (value: string): string => value.trim().replace(/^@+/, '').replace(/^\/+/, '')

export const getManagerProfileExternalUrl = (url: string): string => withProtocol(url.trim())

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
  const social = (entity.social ?? {}) as Partial<EulerLabelEntity['social']>
  const links: Array<ManagerProfileExternalLink | null> = [
    entity.url ? { label: 'Website', url: withProtocol(entity.url) } : null,
    social.twitter
      ? { label: 'X', url: getManagerProfileSocialUrl('twitter', social.twitter) }
      : null,
    social.github
      ? { label: 'GitHub', url: getManagerProfileSocialUrl('github', social.github) }
      : null,
    social.discord
      ? { label: 'Discord', url: getManagerProfileSocialUrl('discord', social.discord) }
      : null,
    social.telegram
      ? { label: 'Telegram', url: getManagerProfileSocialUrl('telegram', social.telegram) }
      : null,
    social.youtube
      ? { label: 'YouTube', url: getManagerProfileSocialUrl('youtube', social.youtube) }
      : null,
  ]

  return links.filter((link): link is ManagerProfileExternalLink => Boolean(link?.url))
}

export const getManagerProfileAddressEntries = (
  entity: EulerLabelEntity,
): ManagerProfileAddressEntry[] =>
  Object.entries(entity.addresses)
    .map(([address, label]) => ({
      address,
      label: label || 'Manager address',
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.address.localeCompare(b.address))

export const getShortAddress = (address: string): string =>
  `${address.slice(0, 6)}...${address.slice(-4)}`

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
