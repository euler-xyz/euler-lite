import type { EulerLabelEntity, EulerLabelProduct } from '~/entities/euler/labels'

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
