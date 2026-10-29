<script setup lang="ts">
import type { CuratorNetworkIndex, CuratorNetworkSummary, CuratorProfileData } from '~/utils/curator-profile'
import { autoLink } from '~/utils/autoLink'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { getChainById } from '~/entities/chainRegistry'
import { getChainLogoUrl } from '~/utils/chain-logo'
import {
  getCuratorProfileCompleteness,
  getCuratorProfileSocialLinks,
} from '~/utils/curator-profile'

defineOptions({
  name: 'CuratorProfilePage',
})

const route = useRoute()
const router = useRouter()
const { changeChain } = useWagmi()
const entityId = computed(() => route.params.slug as string)
const { chainId, allowedChainIds } = useEulerAddresses()
const networkName = computed(() => getChainById(chainId.value)?.name ?? 'this network')
const {
  fallbackEntity,
  managedMarkets,
  earnVaults,
  isUnavailable,
  isLoading,
} = useEulerCuratorProfile(entityId)

const activeTab = computed<string>({
  get: () => route.query.tab === 'earn' ? 'earn' : 'markets',
  set: (tab) => {
    router.replace({ query: { ...route.query, tab }, hash: route.hash })
  },
})
const showNetworkListings = async (network: CuratorNetworkSummary) => {
  await changeChain(network.chainId)
  activeTab.value = network.productCount ? 'markets' : 'earn'
}
const tabs = computed(() => [
  {
    label: 'Markets',
    value: 'markets',
    badge: isUnavailable.value ? undefined : String(managedMarkets.value.length),
    badgeLoading: isLoading.value,
  },
  {
    label: 'Earn',
    value: 'earn',
    badge: isUnavailable.value ? undefined : String(earnVaults.value.length),
    badgeLoading: isLoading.value,
  },
])

const {
  data: profileData,
  status: profileStatus,
  error: profileError,
  refresh: refreshProfile,
} = useFetch<CuratorProfileData>(
  () => `/api/internal/curator-profiles/${encodeURIComponent(entityId.value)}`,
  { server: false, timeout: 20_000 },
)

const profileEntity = computed(() => {
  if (profileData.value?.source === 'v3') {
    return profileData.value.entity?.id === entityId.value ? profileData.value.entity : null
  }
  if (profileData.value?.source === 'static' || profileError.value) {
    return fallbackEntity.value
  }
  return null
})
const profileLogo = computed(() => profileEntity.value ? getEulerLabelEntityLogo(profileEntity.value.logo) : '')
const isProfileLoading = computed(() => profileStatus.value === 'idle' || profileStatus.value === 'pending'
  || (profileData.value?.source === 'static' && isLoading.value && !profileEntity.value))
const isProfileUnavailable = computed(() => Boolean(profileError.value)
  || (profileData.value?.source === 'static' && isUnavailable.value))

const {
  data: networkIndex,
  status: networksStatus,
  error: networksError,
  refresh: refreshNetworks,
} = useFetch<CuratorNetworkIndex>(
  () => `/api/internal/curator-networks/${encodeURIComponent(entityId.value)}`,
  { server: false, timeout: 30_000 },
)

const networkRows = computed(() =>
  (networkIndex.value?.networks ?? [])
    .filter(network => allowedChainIds.value.includes(network.chainId))
    .map(network => ({
      ...network,
      name: getChainById(network.chainId)?.name ?? `Chain ${network.chainId}`,
      logo: getChainLogoUrl(network.chainId),
    }))
    .sort((a, b) => Number(b.chainId === 1) - Number(a.chainId === 1)
      || a.name.localeCompare(b.name)),
)
const selectedNetwork = computed(() => networkRows.value.find(network => network.chainId === chainId.value))

const socialLinks = computed(() => profileEntity.value ? getCuratorProfileSocialLinks(profileEntity.value) : [])
const profileInformation = computed(() => profileEntity.value ? getCuratorProfileCompleteness(profileEntity.value) : null)
const profileCompleteness = computed(() => profileData.value?.source === 'v3'
  && profileStatus.value === 'success' && !profileError.value
  ? profileInformation.value
  : null)
const profileCompletenessTooltip = computed(() => {
  if (!profileCompleteness.value) return ''
  const explanation = 'Eight fields count equally: description, website, legal entity, risk methodology, security, terms of service, licenses and disclaimers. This measures information provided without assessing its content. An explicit statement that something does not apply counts as provided.'
  const missing = profileCompleteness.value.total - profileCompleteness.value.provided
  return missing
    ? `${profileEntity.value.name} has not provided ${missing} profile ${missing === 1 ? 'detail' : 'details'}. ${explanation}`
    : explanation
})
const profileDescription = computed(() => profileInformation.value?.fields.find(field => field.key === 'description'))
const profileWebsite = computed(() => profileInformation.value?.fields.find(field => field.key === 'url'))
const profileDetails = computed(() => (profileInformation.value?.fields ?? [])
  .filter(field => field.key !== 'description' && field.key !== 'url')
  .filter(field => profileCompleteness.value || field.value))
</script>

<template>
  <section class="flex flex-col gap-24">
    <div
      v-if="isProfileLoading && !profileEntity"
      class="flex min-h-[calc(100dvh-178px)] items-center justify-center"
    >
      <UiLoader />
    </div>

    <div
      v-else-if="isProfileUnavailable && !profileEntity"
      class="flex min-h-[calc(100dvh-178px)] items-center justify-center"
    >
      <LabelsUnavailableState
        v-if="profileData?.source === 'static'"
        title="Curator profile unavailable"
        description="Published curator details and market ownership could not be loaded. Try again when vault verification is available."
      />
      <UiEmptyState
        v-else
        title="Curator profile unavailable"
        description="Published curator details could not be loaded. Try again to view this curator's profile."
        icon="warning-circle"
      >
        <template #action>
          <UiButton
            variant="primary-stroke"
            size="small"
            :disabled="profileStatus === 'pending'"
            @click="refreshProfile()"
          >
            {{ profileStatus === 'pending' ? 'Retrying…' : 'Try again' }}
          </UiButton>
        </template>
      </UiEmptyState>
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
        Curator profile not found.
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
            :src="profileLogo"
            class="!h-72 !w-72 shrink-0"
          />
          <div class="min-w-0 flex-1">
            <h1 class="text-h2 text-content-primary mobile:text-h3">
              {{ profileEntity.name }}
            </h1>
            <div
              v-if="profileError && !profileData"
              class="mt-8 flex flex-col items-start gap-8"
            >
              <p class="text-p3 text-content-tertiary">
                Showing available curator details. Try again to load the full profile.
              </p>
              <UiButton
                variant="primary-stroke"
                size="small"
                :disabled="profileStatus === 'pending'"
                @click="refreshProfile()"
              >
                {{ profileStatus === 'pending' ? 'Retrying…' : 'Try again' }}
              </UiButton>
            </div>
            <!-- eslint-disable vue/no-v-html -- autoLink escapes label text before adding links -->
            <p
              v-if="profileDescription?.value"
              class="mt-8 max-w-[760px] text-p2 text-content-secondary auto-link"
              v-html="autoLink(profileDescription.value)"
            />
            <!-- eslint-enable vue/no-v-html -->
            <p
              v-else
              class="mt-8 max-w-[760px] text-p2 text-content-tertiary"
            >
              {{ profileCompleteness ? profileDescription?.missingText : 'No profile description is available.' }}
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
            <p
              v-if="profileCompleteness && !profileWebsite?.value"
              class="mt-12 text-p3 text-content-tertiary"
            >
              {{ profileWebsite?.missingText }}
            </p>
          </div>
        </div>
      </section>

      <div class="flex flex-col gap-24">
        <section
          v-if="profileCompleteness || profileDetails.length"
          aria-labelledby="profile-details-title"
          class="flex flex-col gap-12"
        >
          <div class="flex flex-wrap items-center justify-between gap-12">
            <h2
              id="profile-details-title"
              class="flex items-center gap-8 text-h3 text-content-primary"
            >
              Profile details
              <UiHoverPreviewTooltip
                v-if="profileCompleteness"
                title="Profile completeness"
                :text="profileCompletenessTooltip"
              />
            </h2>
            <div
              v-if="profileCompleteness"
              class="flex flex-wrap items-baseline gap-x-12 gap-y-4"
            >
              <span class="text-h3 text-content-primary">{{ profileCompleteness.percentage }}% complete</span>
              <span class="text-p3 text-content-tertiary">{{ profileCompleteness.provided }} of {{ profileCompleteness.total }} details provided</span>
            </div>
          </div>
          <UiProgress
            v-if="profileCompleteness"
            :model-value="profileCompleteness.percentage"
            :max="100"
            size="small"
            rounded
            role="progressbar"
            aria-label="Profile completeness"
            :aria-valuenow="profileCompleteness.percentage"
            :aria-valuemin="0"
            :aria-valuemax="100"
            :aria-valuetext="`${profileCompleteness.provided} of ${profileCompleteness.total} details provided`"
          />
          <div class="grid grid-cols-2 gap-12 mobile:grid-cols-1">
            <div
              v-for="detail in profileDetails"
              :key="detail.key"
              class="rounded-12 border border-line-subtle bg-surface-elevated p-16"
            >
              <div class="flex flex-wrap items-center justify-between gap-8">
                <h3 class="text-p2 text-content-primary">
                  {{ detail.label }}
                </h3>
                <span
                  v-if="!detail.value"
                  class="inline-flex shrink-0 items-center whitespace-nowrap rounded-8 bg-warning-100 px-8 py-2 text-p5 text-warning-500"
                >Not provided</span>
              </div>
              <!-- eslint-disable vue/no-v-html -- autoLink escapes label text before adding links -->
              <p
                v-if="detail.value"
                class="mt-8 text-p2 text-content-primary auto-link"
                v-html="autoLink(detail.value)"
              />
              <!-- eslint-enable vue/no-v-html -->
              <p
                v-else
                class="mt-8 text-p3 text-content-tertiary"
              >
                {{ detail.missingText }}
              </p>
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
            Published label counts include vaults that may be hidden or deprecated. Select a network to see what is currently listed in the app.
          </p>
          <div
            v-if="networkRows.length"
            class="grid grid-cols-3 gap-12 mobile:grid-cols-1 tablet:grid-cols-2"
          >
            <button
              v-for="network in networkRows"
              :key="network.chainId"
              type="button"
              :aria-label="`View ${network.productCount ? 'markets' : 'Earn vaults'} on ${network.name}`"
              :aria-pressed="network.chainId === chainId"
              class="flex min-w-0 items-center gap-10 rounded-12 border p-12 text-left transition-colors"
              :class="network.chainId === chainId
                ? 'border-accent-600 bg-surface-secondary'
                : 'border-line-subtle bg-surface-elevated hover:border-line-emphasis'"
              @click="showNetworkListings(network)"
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
            </button>
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
      </div>

      <UiTabs
        v-model="activeTab"
        :list="tabs"
        label="Curator listings"
        rounded
        pills
      />

      <section
        class="flex flex-col gap-16"
        role="tabpanel"
        :aria-label="activeTab === 'markets' ? 'Markets' : 'Earn vaults'"
      >
        <h2 class="text-h3 text-content-primary">
          {{ activeTab === 'markets' ? 'Markets' : 'Earn vaults' }}
        </h2>

        <Transition name="instant-fade">
          <section
            v-if="isLoading"
            key="loading"
            class="flex min-h-96 items-center gap-10 rounded-12 border border-line-subtle bg-surface-elevated p-16 text-p3 text-content-tertiary"
            role="status"
          >
            <UiLoader class="!h-20 !w-20 shrink-0" />
            Loading {{ activeTab === 'markets' ? 'markets' : 'Earn vaults' }} for {{ networkName }}…
          </section>

          <section
            v-else-if="isUnavailable"
            key="error"
            class="rounded-12 border border-line-subtle bg-surface-elevated"
          >
            <LabelsUnavailableState
              title="Network listings unavailable"
              :description="profileData?.source === 'static'
                ? 'Published labels for this network could not be loaded. The curator details above may be from your previous network; try again to see current markets and Earn vaults.'
                : 'Published labels for this network could not be loaded. The curator profile remains available; try again to see current markets and Earn vaults.'"
            />
          </section>

          <div
            v-else
            :key="`ready-${chainId}-${activeTab}`"
            class="flex flex-col gap-12"
          >
            <DiscoveryMarketAccordion
              v-if="activeTab === 'markets' && managedMarkets.length"
              :markets="managedMarkets"
            />

            <template v-else-if="activeTab === 'earn' && earnVaults.length">
              <VaultEarnItem
                v-for="vault in earnVaults"
                :key="vault.address"
                :vault="vault"
              />
            </template>

            <p
              v-else
              class="rounded-12 border border-line-subtle p-16 text-p2 text-content-tertiary"
            >
              <template v-if="selectedNetwork">
                {{ profileEntity.name }} has published labels on {{ selectedNetwork.name }}, but no {{ activeTab === 'markets' ? 'markets' : 'Earn vaults' }} are currently listed here. Published labels can include hidden or deprecated vaults.
              </template>
              <template v-else>
                No {{ activeTab === 'markets' ? 'markets' : 'Earn vaults' }} are currently listed on {{ networkName }}.
              </template>
            </p>
          </div>
        </Transition>
      </section>
    </template>
  </section>
</template>
