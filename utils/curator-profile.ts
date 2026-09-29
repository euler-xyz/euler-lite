import type { EulerLabelEntity, EulerLabelProduct } from '~/entities/euler/labels'

export type CuratorProfileExternalLink = {
  label: string
  url: string
}

export type CuratorNetworkSummary = {
  chainId: number
  productCount: number
  earnVaultCount: number
}

export type CuratorNetworkIndex = {
  source: 'v3' | 'static'
  networks: CuratorNetworkSummary[]
}

const asHttpsUrl = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const repaired = /^hhttps:\/\//i.test(trimmed) ? trimmed.slice(1) : trimmed
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(repaired) ? repaired : `https://${repaired}`
  try {
    const url = new URL(candidate)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''
  }
  catch {
    return ''
  }
}

const SOCIAL_LINK_LABELS: Record<string, string> = {
  twitter: 'X',
  github: 'GitHub',
  discord: 'Discord',
  telegram: 'Telegram',
  youtube: 'YouTube',
  defillama: 'DefiLlama',
}

const SOCIAL_HANDLE_BASE: Record<string, string> = {
  twitter: 'https://x.com/',
  github: 'https://github.com/',
  discord: 'https://discord.gg/',
  telegram: 'https://t.me/',
  youtube: 'https://youtube.com/@',
}

const getSocialLinkLabel = (platform: string): string =>
  SOCIAL_LINK_LABELS[platform] ?? platform
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')

export const getCuratorProfileExternalUrl = asHttpsUrl

export const getCuratorProfileSocialUrl = (platform: string, value: string): string => {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (/^h?https?:\/\//i.test(trimmed)) return asHttpsUrl(trimmed)
  const base = SOCIAL_HANDLE_BASE[platform]
  if (!base) return asHttpsUrl(trimmed)
  const handle = trimmed.replace(/^@+/, '').replace(/^\/+/, '')
  return handle ? asHttpsUrl(`${base}${handle}`) : ''
}

export const getCuratorProfileSocialLinks = (entity: EulerLabelEntity): CuratorProfileExternalLink[] => {
  const links = [
    entity.url ? { label: 'Website', url: asHttpsUrl(entity.url) } : null,
    ...Object.entries(entity.social ?? {}).map(([platform, value]) => value
      ? { label: getSocialLinkLabel(platform), url: getCuratorProfileSocialUrl(platform, value) }
      : null),
  ].filter((link): link is CuratorProfileExternalLink => Boolean(link?.url))

  const seen = new Set<string>()
  return links.filter((link) => {
    const key = `${link.label}:${link.url}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const getEulerLabelEntityKeys = (product: EulerLabelProduct): string[] =>
  Array.isArray(product.entity) ? product.entity : product.entity ? [product.entity] : []

export const isEulerLabelProductManagedBy = (product: EulerLabelProduct, entityId: string): boolean =>
  getEulerLabelEntityKeys(product).includes(entityId)

export const getEulerLabelEntityId = (
  entities: Record<string, EulerLabelEntity>,
  entity: EulerLabelEntity,
): string => {
  if (entity.id && entities[entity.id]) return entity.id
  return Object.entries(entities).find(([, value]) => value === entity)?.[0] ?? ''
}

export const getEulerLabelEntityDisplayName = (entities: EulerLabelEntity[]): string => {
  if (entities.length === 0) return ''
  if (entities.length === 1) return entities[0].name
  if (entities.length === 2) return `${entities[0].name} & ${entities[1].name}`
  return `${entities[0].name} & others`
}

export const getCuratorProfilePath = (entityId: string): string => `/curators/${encodeURIComponent(entityId)}`
