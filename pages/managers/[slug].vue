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
const slug = computed(() => route.params.slug as string)
const {
  entity,
  productEntries,
  managedMarkets,
  earnVaults,
  isLoading,
} = useEulerManagerProfile(slug)

const socialLinks = computed(() => entity.value ? getManagerProfileSocialLinks(entity.value) : [])
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
      v-else-if="!entity"
      class="flex min-h-[calc(100dvh-178px)] flex-col items-center justify-center gap-12 text-content-tertiary"
    >
      <UiIcon
        name="search"
        class="!w-24 !h-24"
      />
      <p class="text-center max-w-[280px]">
        Manager not found on this network.
      </p>
      <NuxtLink
        to="/explore"
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
            <!-- eslint-disable vue/no-v-html -- trusted label content -->
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
          </div>
        </div>

        <div class="grid grid-cols-2 gap-12 mobile:grid-cols-1">
          <div class="rounded-8 border border-line-subtle bg-surface-secondary p-16">
            <p class="text-p4 uppercase text-content-tertiary">
              Products
            </p>
            <p class="mt-4 text-h3 text-content-primary">
              {{ productEntries.length }}
            </p>
          </div>
          <div class="rounded-8 border border-line-subtle bg-surface-secondary p-16">
            <p class="text-p4 uppercase text-content-tertiary">
              Markets
            </p>
            <p class="mt-4 text-h3 text-content-primary">
              {{ managedMarkets.length }}
            </p>
          </div>
        </div>

        <div
          v-if="socialLinks.length"
          class="flex flex-wrap gap-8"
        >
          <a
            v-for="link in socialLinks"
            :key="link.label"
            :href="link.url"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-6 rounded-8 border border-line-default bg-surface-elevated px-12 py-8 text-p3 text-content-primary hover:border-line-emphasis hover:text-accent-600 transition-colors"
          >
            <UiIcon
              name="globe"
              class="!h-16 !w-16"
            />
            {{ link.label }}
          </a>
        </div>
      </section>

      <section
        v-if="managedMarkets.length"
        class="flex flex-col gap-12"
      >
        <div class="flex items-center justify-between gap-12">
          <h2 class="text-h3 text-content-primary">
            Markets
          </h2>
        </div>
        <DiscoveryMarketAccordion :markets="managedMarkets" />
      </section>

      <section
        v-if="earnVaults.length"
        class="flex flex-col gap-12"
      >
        <h2 class="text-h3 text-content-primary">
          Earn vaults
        </h2>
        <VaultEarnItem
          v-for="vault in earnVaults"
          :key="vault.address"
          :vault="vault"
        />
      </section>
    </template>
  </section>
</template>
