<script setup lang="ts">
import type { EulerLabelEntity } from '~/entities/euler/labels'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { autoLink } from '~/utils/autoLink'

const { entities, title = 'Curator details' } = defineProps<{
  entities: EulerLabelEntity[]
  title?: string
}>()

const externalUrl = (value: string | undefined): string | null => {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  }
  catch {
    return null
  }
}

const fields = (entity: EulerLabelEntity) => ([
  { label: 'Legal name', value: entity.legalEntityName },
  { label: 'About', value: entity.description },
  { label: 'Risk methodology', value: entity.riskMethodology },
  { label: 'Security', value: entity.security },
  { label: 'Terms of service', value: entity.termsOfService },
  { label: 'Licenses', value: entity.licenses },
  { label: 'Disclaimers', value: entity.disclaimers },
]).filter((field): field is { label: string, value: string } => !!field.value?.trim())

const socialLinks = (entity: EulerLabelEntity) => ([
  { label: 'X', url: externalUrl(entity.social?.twitter) },
  { label: 'YouTube', url: externalUrl(entity.social?.youtube) },
  { label: 'Discord', url: externalUrl(entity.social?.discord) },
  { label: 'Telegram', url: externalUrl(entity.social?.telegram) },
  { label: 'GitHub', url: externalUrl(entity.social?.github) },
  { label: 'DefiLlama', url: externalUrl(entity.social?.defillama) },
]).filter((link): link is { label: string, url: string } => !!link.url)

const publishedEntities = computed(() => entities.filter(entity =>
  fields(entity).length || externalUrl(entity.url) || socialLinks(entity).length,
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
          v-if="externalUrl(entity.url)"
          :href="externalUrl(entity.url) || undefined"
          target="_blank"
          rel="noopener noreferrer"
          class="text-p3 text-accent-600 underline"
        >Website</a>
      </div>
      <div
        v-for="field in fields(entity)"
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
        v-if="socialLinks(entity).length"
        class="flex flex-wrap gap-12"
      >
        <a
          v-for="link in socialLinks(entity)"
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
