<script setup lang="ts">
import type { EulerLabelEntity } from '~/entities/euler/labels'
import { entityDisclosureUrl, getEntityDisclosureFields, getEntitySocialLinks } from '~/utils/entity-disclosures'

const props = defineProps<{ entities: EulerLabelEntity[] }>()

const sections = computed(() => {
  const named = props.entities.length > 1
  return props.entities.flatMap((entity) => {
    const title = (label: string) => named ? `${entity.name} · ${label}` : label
    const website = entityDisclosureUrl(entity.url)
    return [
      ...getEntityDisclosureFields(entity).map(field => ({ title: title(field.label), text: field.value })),
      ...(website ? [{ title: title('Website'), text: website }] : []),
      ...getEntitySocialLinks(entity).map(link => ({ title: title(link.label), text: link.url })),
    ]
  })
})
</script>

<template>
  <UiHoverPreviewTooltip
    v-if="sections.length"
    title="Curator details"
    :sections="sections"
    placement="top-start"
  >
    <slot />
  </UiHoverPreviewTooltip>
  <slot v-else />
</template>
