<script setup lang="ts">
import { autoLink } from '~/utils/autoLink'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { getExplorerLink } from '~/utils/block-explorer'
import {
  getManagerProfileAddressEntries,
  getManagerProfileExternalUrl,
  getManagerProfileSocialLinks,
  getShortAddress,
} from '~/utils/manager-profile'

defineOptions({
  name: 'ManagerProfilePage',
})

const route = useRoute()
const { chainId } = useEulerAddresses()
const slug = computed(() => route.params.slug as string)
const {
  entity,
  productEntries,
  evaults,
  securitizeVaults,
  earnVaults,
  vaultCount,
  isLoading,
} = useEulerManagerProfile(slug)

const socialLinks = computed(() => entity.value ? getManagerProfileSocialLinks(entity.value) : [])
const addressEntries = computed(() => entity.value ? getManagerProfileAddressEntries(entity.value) : [])

const hasVaults = computed(() =>
  evaults.value.length > 0 || securitizeVaults.value.length > 0 || earnVaults.value.length > 0,
)

const getExplorerAddressLink = (address: string) => getExplorerLink(address, chainId.value, true)

const copyAddress = (address: string) => {
  navigator.clipboard.writeText(address)
}
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
      <div class="flex items-center gap-12">
        <BackButton fallback="/explore" />
        <p class="text-p3 text-content-tertiary">
          Manager profile
        </p>
      </div>

      <section class="flex flex-col gap-24 border-b border-line-subtle pb-24">
        <div class="flex items-start gap-20 mobile:flex-col">
          <BaseAvatar
            :label="entity.name"
            :src="getEulerLabelEntityLogo(entity.logo)"
            class="!h-72 !w-72"
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

        <div class="grid grid-cols-4 gap-12 mobile:grid-cols-1">
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
              Vaults
            </p>
            <p class="mt-4 text-h3 text-content-primary">
              {{ vaultCount }}
            </p>
          </div>
          <div class="rounded-8 border border-line-subtle bg-surface-secondary p-16">
            <p class="text-p4 uppercase text-content-tertiary">
              Links
            </p>
            <p class="mt-4 text-h3 text-content-primary">
              {{ socialLinks.length }}
            </p>
          </div>
          <div class="rounded-8 border border-line-subtle bg-surface-secondary p-16">
            <p class="text-p4 uppercase text-content-tertiary">
              Addresses
            </p>
            <p class="mt-4 text-h3 text-content-primary">
              {{ addressEntries.length }}
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
        v-if="addressEntries.length"
        class="flex flex-col gap-12"
      >
        <h2 class="text-h3 text-content-primary">
          Governance addresses
        </h2>
        <div class="grid grid-cols-2 gap-12 mobile:grid-cols-1">
          <div
            v-for="entry in addressEntries"
            :key="entry.address"
            class="rounded-8 border border-line-subtle bg-surface-secondary p-16"
          >
            <p class="text-p3 text-content-primary">
              {{ entry.label }}
            </p>
            <div class="mt-6 flex min-w-0 items-center gap-6">
              <NuxtLink
                :to="getExplorerAddressLink(entry.address)"
                target="_blank"
                class="min-w-0 truncate text-p3 text-accent-600 underline hover:text-accent-500"
              >
                {{ getShortAddress(entry.address) }}
              </NuxtLink>
              <button
                type="button"
                class="shrink-0 text-content-muted outline-none hover:text-content-secondary active:text-content-primary"
                aria-label="Copy address"
                @click="copyAddress(entry.address)"
              >
                <SvgIcon
                  class="!h-16 !w-16"
                  name="copy"
                />
              </button>
            </div>
          </div>
        </div>
      </section>

      <section
        v-if="productEntries.length"
        class="flex flex-col gap-12"
      >
        <div class="flex items-center justify-between gap-12">
          <h2 class="text-h3 text-content-primary">
            Products managed
          </h2>
        </div>
        <div class="grid grid-cols-2 gap-12 mobile:grid-cols-1">
          <div
            v-for="entry in productEntries"
            :key="entry.key"
            class="rounded-12 border border-line-default bg-surface p-16 shadow-card"
          >
            <div class="flex items-start gap-10">
              <BaseAvatar
                v-if="entry.product.logo"
                :label="entry.product.name"
                :src="getEulerLabelEntityLogo(entry.product.logo)"
                class="!h-32 !w-32 shrink-0"
              />
              <div class="min-w-0 flex-1">
                <NuxtLink
                  :to="{ name: 'explore-market', params: { market: entry.key }, query: { network: route.query.network } }"
                  class="text-p2 text-content-primary hover:text-accent-600"
                >
                  {{ entry.product.name }}
                </NuxtLink>
                <p
                  v-if="entry.product.description"
                  class="mt-4 line-clamp-2 text-p3 text-content-tertiary"
                >
                  {{ entry.product.description }}
                </p>
              </div>
            </div>
            <div
              v-if="entry.product.tags?.length || entry.product.url"
              class="mt-12 flex flex-wrap gap-6"
            >
              <span
                v-for="tag in entry.product.tags"
                :key="tag"
                class="rounded-8 bg-surface-secondary px-8 py-4 text-p4 text-content-secondary"
              >
                {{ tag }}
              </span>
              <a
                v-if="entry.product.url"
                :href="getManagerProfileExternalUrl(entry.product.url)"
                target="_blank"
                rel="noopener noreferrer"
                class="rounded-8 bg-surface-secondary px-8 py-4 text-p4 text-accent-600 hover:text-accent-500"
              >
                Website
              </a>
            </div>
          </div>
        </div>
      </section>

      <section class="flex flex-col gap-12">
        <h2 class="text-h3 text-content-primary">
          Vaults managed
        </h2>
        <div
          v-if="!hasVaults"
          class="rounded-12 border border-line-default bg-surface p-24 text-p2 text-content-tertiary"
        >
          No managed vaults are currently available on this network.
        </div>
        <div
          v-if="evaults.length || securitizeVaults.length"
          class="flex flex-col gap-12"
        >
          <h3 class="text-p3 uppercase text-content-tertiary">
            Lending vaults
          </h3>
          <VaultItem
            v-for="vault in evaults"
            :key="vault.address"
            :vault="vault"
          />
          <SecuritizeVaultItem
            v-for="vault in securitizeVaults"
            :key="vault.address"
            :vault="vault"
          />
        </div>
        <div
          v-if="earnVaults.length"
          class="flex flex-col gap-12"
        >
          <h3 class="text-p3 uppercase text-content-tertiary">
            Earn vaults
          </h3>
          <VaultEarnItem
            v-for="vault in earnVaults"
            :key="vault.address"
            :vault="vault"
          />
        </div>
      </section>
    </template>
  </section>
</template>
