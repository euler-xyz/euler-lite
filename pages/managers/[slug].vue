<script setup lang="ts">
import { autoLink } from '~/utils/autoLink'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import {
  getManagerProfileSocialLinks,
} from '~/utils/manager-profile'

defineOptions({
  name: 'ManagerProfilePage',
})

const route = useRoute()
const entityId = computed(() => route.params.slug as string)
const {
  entity,
  managedMarkets,
  earnVaults,
  isUnavailable,
  isLoading,
  retryLabels,
} = useEulerManagerProfile(entityId)

const socialLinks = computed(() => entity.value ? getManagerProfileSocialLinks(entity.value) : [])
const profileDetails = computed(() => {
  const current = entity.value
  if (!current) return []
  return [
    { label: 'Legal entity', value: current.legalEntityName },
    { label: 'Risk methodology', value: current.riskMethodology },
    { label: 'Security', value: current.security },
    { label: 'Terms of service', value: current.termsOfService },
    { label: 'Licenses', value: current.licenses },
    { label: 'Disclaimers', value: current.disclaimers },
  ].filter((entry): entry is { label: string, value: string } => Boolean(entry.value?.trim()))
})
</script>

<template>
  <section class="flex flex-col gap-24">
    <div
      v-if="isLoading"
      class="flex min-h-[calc(100dvh-178px)] items-center justify-center"
    >
      <UiLoader />
    </div>

    <div
      v-else-if="isUnavailable"
      class="flex min-h-[calc(100dvh-178px)] flex-col items-center justify-center gap-12 text-content-tertiary"
    >
      <p class="text-center max-w-[320px]">
        Manager profiles are temporarily unavailable.
      </p>
      <button
        type="button"
        class="text-p3 text-accent-600 underline"
        @click="retryLabels"
      >
        Try again
      </button>
    </div>

    <div
      v-else-if="!entity"
      class="flex min-h-[calc(100dvh-178px)] flex-col items-center justify-center gap-12 text-content-tertiary"
    >
      <UiIcon
        name="search"
        class="!w-24 !h-24"
      />
      <p class="text-center max-w-[280px]">
        Manager profile not found.
      </p>
      <NuxtLink
        :to="{ path: '/explore', query: { network: route.query.network } }"
        class="text-p3 text-accent-600 underline"
      >
        Browse all markets
      </NuxtLink>
    </div>

    <template v-else>
      <section class="relative flex flex-col gap-24 border-b border-line-subtle pb-24">
        <BackButton
          class="hidden tablet:inline-flex tablet:absolute tablet:top-20 tablet:right-full tablet:mr-12"
          fallback="/explore"
        />
        <div class="flex items-start gap-16 mobile:flex-col">
          <BackButton
            class="tablet:hidden"
            fallback="/explore"
          />
          <BaseAvatar
            :label="entity.name"
            :src="getEulerLabelEntityLogo(entity.logo)"
            class="!h-72 !w-72 shrink-0"
          />
          <div class="min-w-0 flex-1">
            <h1 class="text-h2 text-content-primary mobile:text-h3">
              {{ entity.name }}
            </h1>
            <!-- eslint-disable vue/no-v-html -- autoLink escapes label text before adding links -->
            <p
              v-if="entity.description"
              class="mt-8 max-w-[760px] text-p2 text-content-secondary auto-link"
              v-html="autoLink(entity.description)"
            />
            <!-- eslint-enable vue/no-v-html -->
            <p
              v-else
              class="mt-8 max-w-[760px] text-p2 text-content-tertiary"
            >
              No profile description is available yet.
            </p>
            <div
              v-if="socialLinks.length"
              class="mt-16 flex flex-wrap gap-8"
            >
              <a
                v-for="link in socialLinks"
                :key="`${link.label}:${link.url}`"
                :href="link.url"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-6 rounded-8 border border-line-default bg-surface-elevated px-12 py-8 text-p3 text-content-primary hover:border-line-emphasis hover:text-accent-600 transition-colors"
              >
                {{ link.label }}
                <UiIcon
                  name="arrow-top-right"
                  class="!h-16 !w-16"
                />
              </a>
            </div>
          </div>
        </div>
      </section>

      <section
        v-if="profileDetails.length"
        class="grid grid-cols-2 gap-16 mobile:grid-cols-1"
      >
        <div
          v-for="detail in profileDetails"
          :key="detail.label"
          class="rounded-12 border border-line-subtle bg-surface-elevated p-16"
        >
          <h2 class="text-p3 text-content-tertiary">
            {{ detail.label }}
          </h2>
          <!-- eslint-disable vue/no-v-html -- autoLink escapes label text before adding links -->
          <p
            class="mt-8 text-p2 text-content-primary auto-link"
            v-html="autoLink(detail.value)"
          />
          <!-- eslint-enable vue/no-v-html -->
        </div>
      </section>

      <section
        v-if="managedMarkets.length"
        class="flex flex-col gap-12"
      >
        <div class="flex items-center justify-between gap-12">
          <h2 class="flex items-center gap-8 text-h3 text-content-primary">
            Markets
            <span class="inline-flex min-w-24 items-center justify-center rounded-full bg-surface-secondary px-8 py-2 text-p4 text-content-tertiary">
              {{ managedMarkets.length }}
            </span>
          </h2>
        </div>
        <DiscoveryMarketAccordion :markets="managedMarkets" />
      </section>

      <section
        v-if="earnVaults.length"
        class="flex flex-col gap-12"
      >
        <h2 class="flex items-center gap-8 text-h3 text-content-primary">
          Earn vaults
          <span class="inline-flex min-w-24 items-center justify-center rounded-full bg-surface-secondary px-8 py-2 text-p4 text-content-tertiary">
            {{ earnVaults.length }}
          </span>
        </h2>
        <VaultEarnItem
          v-for="vault in earnVaults"
          :key="vault.address"
          :vault="vault"
        />
      </section>

      <p
        v-if="!managedMarkets.length && !earnVaults.length"
        class="rounded-12 border border-line-subtle p-16 text-p2 text-content-tertiary"
      >
        No markets or Earn vaults are available on this network.
      </p>
    </template>
  </section>
</template>
