import type { EulerLabelEntity } from '~/entities/euler/labels'

export const entityDisclosureUrl = (value: string | undefined): string | null => {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  }
  catch {
    return null
  }
}

export const getEntityDisclosureFields = (entity: EulerLabelEntity) => ([
  { label: 'Legal name', value: entity.legalEntityName },
  { label: 'About', value: entity.description },
  { label: 'Risk methodology', value: entity.riskMethodology },
  { label: 'Security', value: entity.security },
  { label: 'Terms of service', value: entity.termsOfService },
  { label: 'Licenses', value: entity.licenses },
  { label: 'Disclaimers', value: entity.disclaimers },
]).filter((field): field is { label: string, value: string } => !!field.value?.trim())

export const getEntitySocialLinks = (entity: EulerLabelEntity) => ([
  { label: 'X', url: entityDisclosureUrl(entity.social?.twitter) },
  { label: 'YouTube', url: entityDisclosureUrl(entity.social?.youtube) },
  { label: 'Discord', url: entityDisclosureUrl(entity.social?.discord) },
  { label: 'Telegram', url: entityDisclosureUrl(entity.social?.telegram) },
  { label: 'GitHub', url: entityDisclosureUrl(entity.social?.github) },
  { label: 'DefiLlama', url: entityDisclosureUrl(entity.social?.defillama) },
]).filter((link): link is { label: string, url: string } => !!link.url)
