<script setup lang="ts">
import type { EulerLabelEntity } from '~/entities/euler/labels'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { autoLink } from '~/utils/autoLink'
import { entityDisclosureUrl, getEntityDisclosureFields, getEntitySocialLinks } from '~/utils/entity-disclosures'

const { entities, title = 'Curator details' } = defineProps<{
  entities: EulerLabelEntity[]
  title?: string
}>()

const publishedEntities = computed(() => entities.filter(entity =>
  getEntityDisclosureFields(entity).length || entityDisclosureUrl(entity.url) || getEntitySocialLinks(entity).length,
))
</script>

<template>
  <VaultOverviewAccordionSection
    v-if="publishedEntities.length"
    :title="title"
    :default-open="false"
    content-class="flex flex-col gap-24"
  >
    <div
      v-for="entity in publishedEntities"
      :key="entity.id || entity.name"
      class="flex flex-col gap-16"
    >
      <div class="flex items-center gap-8">
        <BaseAvatar
          :label="entity.name"
          :src="getEulerLabelEntityLogo(entity.logo)"
          class="!w-28 !h-28"
        />
        <span class="text-p2 font-semibold text-content-primary">{{ entity.name }}</span>
        <a
          v-if="entityDisclosureUrl(entity.url)"
          :href="entityDisclosureUrl(entity.url) || undefined"
          target="_blank"
          rel="noopener noreferrer"
          class="text-p3 text-accent-600 underline"
        >Website</a>
      </div>
      <div
        v-for="field in getEntityDisclosureFields(entity)"
        :key="field.label"
        class="flex flex-col gap-4"
      >
        <span class="text-p3 text-content-tertiary">{{ field.label }}</span>
        <!-- eslint-disable vue/no-v-html -- autoLink escapes published text before linking -->
        <p
          class="text-p2 text-content-primary auto-link"
          v-html="autoLink(field.value)"
        />
      </div>
      <div
        v-if="getEntitySocialLinks(entity).length"
        class="flex flex-wrap gap-12"
      >
        <a
          v-for="link in getEntitySocialLinks(entity)"
          :key="link.label"
          :href="link.url"
          target="_blank"
          rel="noopener noreferrer"
          class="text-p3 text-accent-600 underline"
        >{{ link.label }}</a>
      </div>
    </div>
  </VaultOverviewAccordionSection>
</template>
