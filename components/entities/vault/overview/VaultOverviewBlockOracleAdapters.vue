<script setup lang="ts">
import type { Address } from 'viem'
import type { Vault, SecuritizeVault } from '~/entities/vault'
import { collectOracleAdapters, type OracleAdapterEntry, type OracleAdapterMeta } from '~/entities/oracle'
import { getOracleProviderLogo } from '~/entities/oracle-providers'
import { getExplorerLink } from '~/utils/block-explorer'
import { formatNumber } from '~/utils/string-utils'
import { useOracleAdapterPrices } from '~/composables/useOracleAdapterPrices'

const props = defineProps<{
  vault?: Vault
  vaults?: Vault[]
  collateralVaults?: (Vault | SecuritizeVault)[]
}>()
const { oracleAdapters, loadOracleAdapter } = useEulerLabels()
const { chainId } = useEulerAddresses()
const { buildKnownSymbols, resolveSymbol: resolveTokenSymbol, shortenAddress } = useTokenSymbolResolver()

const sourceVaults = computed(() => {
  if (props.vaults?.length) {
    return props.vaults
  }

  if (props.vault) {
    return [props.vault]
  }

  return []
})

const skipERC4626Bases = computed(() => {
  const bases = new Set<string>()
  props.collateralVaults?.forEach((vault) => {
    bases.add(vault.address.toLowerCase())
  })
  return bases
})

const adapters = computed(() => {
  const entries: OracleAdapterEntry[] = []
  const deduped = new Map<string, OracleAdapterEntry>()

  sourceVaults.value.forEach((vault) => {
    entries.push(...collectOracleAdapters(vault.oracleDetailedInfo, 3, {
      base: vault.asset.address as Address,
      quote: vault.unitOfAccount as Address,
      leafOnly: true,
    }))

    if (props.collateralVaults?.length) {
      props.collateralVaults.forEach((collateralVault) => {
        entries.push(...collectOracleAdapters(vault.oracleDetailedInfo, 3, {
          base: collateralVault.address as Address,
          quote: vault.unitOfAccount as Address,
          leafOnly: true,
          skipERC4626Bases: skipERC4626Bases.value,
        }))
      })
    }
  })

  entries.forEach((adapter) => {
    const key = `${adapter.oracle.toLowerCase()}:${adapter.base.toLowerCase()}:${adapter.quote.toLowerCase()}`
    if (!deduped.has(key)) {
      deduped.set(key, adapter)
    }
  })

  return [...deduped.values()]
})

const knownSymbols = computed(() => {
  const map = buildKnownSymbols()

  sourceVaults.value.forEach((vault) => {
    map.set(vault.asset.address.toLowerCase(), vault.asset.symbol)
    if (vault.unitOfAccountSymbol) {
      map.set(vault.unitOfAccount.toLowerCase(), vault.unitOfAccountSymbol)
    }
  })

  props.collateralVaults?.forEach((vault) => {
    map.set(vault.address.toLowerCase(), vault.asset.symbol)
  })

  return map
})

const adapterViews = computed(() => adapters.value.map((adapter) => {
  const meta: OracleAdapterMeta | undefined = oracleAdapters[adapter.oracle.toLowerCase()]
  const isERC4626 = adapter.name === 'ERC4626Vault'
  const provider = meta?.provider || (isERC4626 ? 'ERC4626Vault' : undefined)
  const name = meta?.name || adapter.name

  return {
    ...adapter,
    name,
    provider,
    methodology: meta?.methodology || (isERC4626 ? 'Exchange Rate' : undefined),
    logo: getOracleProviderLogo(provider, name),
  }
}))

watch(
  () => adapters.value,
  async (adapterList) => {
    if (!chainId.value || !adapterList.length) return

    await Promise.all(
      adapterList
        .filter(a => a.name !== 'ERC4626Vault')
        .map(a => loadOracleAdapter(chainId.value, a.oracle)),
    )
  },
  { immediate: true },
)

const resolveSymbol = (address: string) => resolveTokenSymbol(address, knownSymbols.value)

const onCopyClick = (address: string) => {
  navigator.clipboard.writeText(address)
}

const getAdapterKey = (adapter: OracleAdapterEntry) => `${adapter.oracle.toLowerCase()}:${adapter.base.toLowerCase()}:${adapter.quote.toLowerCase()}`
const getExplorerAddressLink = (address: string) => getExplorerLink(address, chainId.value, true)

const { prices: adapterPrices, isLoading: isPriceLoading } = useOracleAdapterPrices(
  adapters,
  sourceVaults,
  computed(() => props.collateralVaults ?? []),
)

const isAdapterPriceFailed = (adapter: OracleAdapterEntry) => {
  const key = getAdapterKey(adapter)
  const info = adapterPrices.value.get(key)
  return !info?.success
}

const formatAdapterPrice = (adapter: OracleAdapterEntry) => {
  const key = getAdapterKey(adapter)
  const info = adapterPrices.value.get(key)
  if (!info?.success) return '-'
  return formatNumber(info.rate, 4)
}
</script>

<template>
  <div class="flex flex-col gap-24 p-24 border-b border-line-default last:border-b-0">
    <p class="text-h3 text-content-primary">
      Oracles
    </p>
    <div
      v-if="!adapterViews.length"
      class="text-p3 text-content-tertiary"
    >
      No oracle adapters found
    </div>
    <div
      v-else
      class="flex flex-col items-start gap-16"
    >
      <div
        v-for="adapter in adapterViews"
        :key="getAdapterKey(adapter)"
        class="w-full rounded-xl bg-surface p-16 flex flex-col gap-12 border border-line-subtle"
      >
        <div class="flex flex-wrap items-center gap-8">
          <div class="p2 text-content-primary">
            {{ resolveSymbol(adapter.base) }}/{{ resolveSymbol(adapter.quote) }}
          </div>
          <NuxtLink
            :to="getExplorerAddressLink(adapter.oracle)"
            class="text-accent-600 underline cursor-pointer hover:text-accent-500"
            target="_blank"
          >
            {{ shortenAddress(adapter.oracle) }}
          </NuxtLink>
          <button
            :class="$style.copyBtn"
            class="text-content-muted"
            @click="onCopyClick(adapter.oracle)"
          >
            <SvgIcon
              class="!w-18 !h-18"
              name="copy"
            />
          </button>
        </div>
        <div class="grid grid-cols-3 gap-12 text-p4">
          <div class="flex flex-col gap-4">
            <span class="text-content-tertiary">Provider</span>
            <div class="flex items-center gap-8">
              <BaseAvatar
                v-if="adapter.logo"
                :src="adapter.logo"
                :label="adapter.name"
                class="icon--20"
              />
              <SvgIcon
                v-else
                name="question-circle"
                class="!w-20 !h-20 text-content-tertiary"
              />
              <span class="text-content-primary">{{ adapter.provider || 'Unknown' }}</span>
            </div>
          </div>
          <div class="flex flex-col gap-4">
            <span class="text-content-tertiary">Methodology</span>
            <span class="text-content-primary">{{ adapter.methodology || 'Unknown' }}</span>
          </div>
          <div class="flex flex-col gap-4">
            <span class="text-content-tertiary">Price</span>
            <span
              v-if="isPriceLoading"
              class="text-content-secondary animate-pulse"
            >...</span>
            <span
              v-else-if="isAdapterPriceFailed(adapter)"
              class="flex items-center text-warning-500"
            >
              <SvgIcon
                name="warning"
                class="mr-2 !w-20 !h-20"
              />
              Unknown
            </span>
            <span
              v-else
              class="text-content-primary"
            >{{ formatAdapterPrice(adapter) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style module lang="scss">
.copyBtn {
  cursor: pointer;
  outline: none;

  &:hover {
    color: var(--text-secondary);
  }

  &:active {
    color: var(--text-primary);
  }
}
</style>
