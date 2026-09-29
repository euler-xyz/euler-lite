<script setup lang="ts">
import type { ManagerNetworkIndex } from '~/utils/manager-profile'
import { autoLink } from '~/utils/autoLink'
import { getEulerLabelEntityLogo, type EulerLabelEntity } from '~/entities/euler/labels'
import { getChainById } from '~/entities/chainRegistry'
import { getChainLogoUrl } from '~/utils/chain-logo'
import {
  getManagerProfileSocialLinks,
} from '~/utils/manager-profile'

defineOptions({
  name: 'ManagerProfilePage',
})

const route = useRoute()
const entityId = computed(() => route.params.slug as string)
const { chainId } = useEulerAddresses()
const {
  entity,
  managedMarkets,
  earnVaults,
  isUnavailable,
  isLoading,
  retryLabels,
} = useEulerManagerProfile(entityId)

// Chain-specific labels are cleared while the next network loads. Keep the
// shared manager identity visible during that interval.
const visibleProfile = shallowRef<{ id: string, entity: EulerLabelEntity, logo: string } | null>(null)
watch([entityId, entity], ([id, current]) => {
  if (current) {
    visibleProfile.value = { id, entity: current, logo: getEulerLabelEntityLogo(current.logo) }
  }
  else if (visibleProfile.value?.id !== id) {
    visibleProfile.value = null
  }
}, { immediate: true, flush: 'sync' })
const profileEntity = computed(() => visibleProfile.value?.entity ?? null)

const {
  data: networkIndex,
  status: networksStatus,
  error: networksError,
  refresh: refreshNetworks,
} = useFetch<ManagerNetworkIndex>(
  () => `/api/internal/manager-networks/${encodeURIComponent(entityId.value)}`,
  { server: false, timeout: 30_000 },
)

const networkRows = computed(() =>
  (networkIndex.value?.networks ?? [])
    .map(network => ({
      ...network,
      name: getChainById(network.chainId)?.name ?? `Chain ${network.chainId}`,
      logo: getChainLogoUrl(network.chainId),
    }))
    .sort((a, b) => Number(b.chainId === 1) - Number(a.chainId === 1)
      || a.name.localeCompare(b.name)),
)
const selectedNetwork = computed(() => networkRows.value.find(network => network.chainId === chainId.value))

const socialLinks = computed(() => profileEntity.value ? getManagerProfileSocialLinks(profileEntity.value) : [])
const profileDetails = computed(() => {
  const current = profileEntity.value
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
      v-if="isLoading && !profileEntity"
      class="flex min-h-[calc(100dvh-178px)] items-center justify-center"
    >
      <UiLoader />
    </div>

    <div
      v-else-if="isUnavailable && !profileEntity"
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
      v-else-if="!profileEntity"
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
            :label="profileEntity.name"
            :src="visibleProfile?.logo"
            class="!h-72 !w-72 shrink-0"
          />
          <div class="min-w-0 flex-1">
            <h1 class="text-h2 text-content-primary mobile:text-h3">
              {{ profileEntity.name }}
            </h1>
            <!-- eslint-disable vue/no-v-html -- autoLink escapes label text before adding links -->
            <p
              v-if="profileEntity.description"
              class="mt-8 max-w-[760px] text-p2 text-content-secondary auto-link"
              v-html="autoLink(profileEntity.description)"
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
        v-if="networkRows.length || networksStatus === 'pending' || networksError"
        class="flex flex-col gap-12"
      >
        <h2 class="flex items-center gap-8 text-h3 text-content-primary">
          Networks
          <span
            v-if="networkRows.length"
            class="inline-flex min-w-24 items-center justify-center rounded-full bg-surface-secondary px-8 py-2 text-p4 text-content-tertiary"
          >
            {{ networkRows.length }}
          </span>
        </h2>
        <p class="text-p3 text-content-tertiary">
          Published label counts include vaults that may be hidden or deprecated. Select a network to see what is currently listed in Lite.
        </p>
        <div
          v-if="networkRows.length"
          class="grid grid-cols-3 gap-12 mobile:grid-cols-1 tablet:grid-cols-2"
        >
          <NuxtLink
            v-for="network in networkRows"
            :key="network.chainId"
            :to="{ path: route.path, query: { ...route.query, network: network.chainId } }"
            :aria-current="network.chainId === chainId ? 'page' : undefined"
            class="flex min-w-0 items-center gap-10 rounded-12 border p-12 transition-colors"
            :class="network.chainId === chainId
              ? 'border-accent-600 bg-surface-secondary'
              : 'border-line-subtle bg-surface-elevated hover:border-line-emphasis'"
          >
            <BaseAvatar
              :label="network.name"
              :src="network.logo"
              class="!w-32 !h-32 shrink-0"
            />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-p2 text-content-primary">{{ network.name }}</span>
              <span class="block text-p4 text-content-tertiary">
                {{ network.productCount }} product {{ network.productCount === 1 ? 'label' : 'labels' }}
                <template v-if="network.earnVaultCount">
                  · {{ network.earnVaultCount }} Earn vault {{ network.earnVaultCount === 1 ? 'label' : 'labels' }}
                </template>
              </span>
            </span>
            <UiIcon
              v-if="network.chainId !== chainId"
              name="arrow-right"
              class="!w-16 !h-16 shrink-0 text-content-tertiary"
            />
          </NuxtLink>
        </div>
        <p
          v-else-if="networksStatus === 'pending'"
          class="text-p3 text-content-tertiary"
        >
          Loading networks…
        </p>
        <button
          v-else-if="networksError"
          type="button"
          class="self-start text-p3 text-accent-600 underline"
          @click="refreshNetworks()"
        >
          Could not load networks. Try again
        </button>
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

      <Transition name="instant-fade">
        <section
          v-if="isLoading"
          key="loading"
          class="flex min-h-96 items-center gap-10 rounded-12 border border-line-subtle bg-surface-elevated p-16 text-p3 text-content-tertiary"
          role="status"
        >
          <UiLoader class="!h-20 !w-20 shrink-0" />
          Loading markets and Earn vaults for {{ getChainById(chainId)?.name ?? 'this network' }}…
        </section>

        <section
          v-else-if="isUnavailable"
          key="error"
          class="flex flex-col gap-8 rounded-12 border border-line-subtle bg-surface-elevated p-16 text-p3 text-content-tertiary"
        >
          <p>Markets and Earn vaults are temporarily unavailable on this network.</p>
          <button
            type="button"
            class="self-start text-accent-600 underline"
            @click="retryLabels"
          >
            Try again
          </button>
        </section>

        <div
          v-else
          :key="`ready-${chainId}`"
          class="flex flex-col gap-24"
        >
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
            <template v-if="selectedNetwork">
              {{ profileEntity.name }} has published labels on {{ selectedNetwork.name }}, but no markets or Earn vaults are currently listed here. Published labels can include hidden or deprecated vaults.
            </template>
            <template v-else>
              No markets or Earn vaults are currently listed on {{ getChainById(chainId)?.name ?? 'this network' }}.
            </template>
          </p>
        </div>
      </Transition>
    </template>
  </section>
</template>
