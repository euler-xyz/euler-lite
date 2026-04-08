<script setup lang="ts">
import type { CSSProperties } from 'vue'
import type { Address } from 'viem'
import type { Vault, SecuritizeVault } from '~/entities/vault'
import { collectOracleAdapters, getChecksStatus, OracleAdapterCheckSeverity, type OracleAdapterEntry, type OracleAdapterMeta } from '~/entities/oracle'
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
  const provider = meta?.provider || adapter.name
  const name = meta?.name || adapter.name
  const checks = meta?.checks

  return {
    ...adapter,
    name,
    provider,
    methodology: meta?.methodology || (isERC4626 ? 'Exchange Rate' : undefined),
    logo: getOracleProviderLogo(provider, name),
    checks,
    checksStatus: getChecksStatus(checks),
    failedChecks: checks?.filter(c => !c.pass) ?? [],
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

const hoveredChecksAdapter = ref<(typeof adapterViews.value)[0] | null>(null)
const tooltipStyle = ref<CSSProperties>({})
const TOOLTIP_WIDTH = 520
let hideTimer: ReturnType<typeof setTimeout> | null = null

const onChecksMouseEnter = (adapter: (typeof adapterViews.value)[0], event: MouseEvent) => {
  if (!adapter.checks?.length) return
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const left = Math.min(rect.left, window.innerWidth - TOOLTIP_WIDTH - 16)
  const spaceBelow = window.innerHeight - rect.bottom - 16
  const spaceAbove = rect.top - 16
  const flipUp = spaceAbove > spaceBelow
  tooltipStyle.value = flipUp
    ? { top: `${rect.top - 8}px`, left: `${left}px`, transform: 'translateY(-100%)', maxHeight: `${spaceAbove}px` }
    : { top: `${rect.bottom + 8}px`, left: `${left}px`, transform: 'none', maxHeight: `${spaceBelow}px` }
  hoveredChecksAdapter.value = adapter
}

const onChecksMouseLeave = () => {
  hideTimer = setTimeout(() => {
    hoveredChecksAdapter.value = null
  }, 150)
}

const onTooltipMouseEnter = () => {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
}

const onTooltipMouseLeave = () => {
  hoveredChecksAdapter.value = null
}
</script>

<template>
  <div class="bg-surface-secondary rounded-xl flex flex-col gap-24 p-24 shadow-card">
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
        <div class="grid grid-cols-4 gap-12 text-p3">
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
          <div
            class="flex flex-col gap-4"
            @mouseenter="onChecksMouseEnter(adapter, $event)"
            @mouseleave="onChecksMouseLeave"
          >
            <span class="text-content-tertiary">Checks</span>
            <span
              v-if="!adapter.checks?.length"
              class="text-content-secondary"
            >N/A</span>
            <span
              v-else
              class="flex items-center gap-6 cursor-default"
            >
              <span
                class="inline-block w-8 h-8 rounded-full flex-shrink-0"
                :class="{
                  'bg-success-500': adapter.checksStatus === 'positive',
                  'bg-warning-500': adapter.checksStatus === 'warning',
                  'bg-error-500': adapter.checksStatus === 'negative',
                }"
              />
              <span class="text-content-primary">
                <template v-if="adapter.checksStatus === 'positive'">
                  {{ adapter.checks.length }} passed
                </template>
                <template v-else>
                  {{ adapter.failedChecks.length }} failed
                </template>
              </span>
            </span>
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
        <div
          v-if="adapter.failedChecks.length"
          class="flex flex-col gap-6 border-t border-line-subtle pt-12 text-p3"
        >
          <div
            v-for="check in adapter.failedChecks"
            :key="check.id"
            class="flex items-start gap-8"
          >
            <SvgIcon
              name="warning"
              class="!w-16 !h-16 mt-1 flex-shrink-0"
              :class="{
                'text-error-500': check.severity === OracleAdapterCheckSeverity.High,
                'text-warning-500': check.severity !== OracleAdapterCheckSeverity.High,
              }"
            />
            <div>
              <span class="text-content-primary font-medium">{{ check.id }}: </span>
              <span class="text-content-secondary">{{ check.message }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <Teleport to="body">
    <div
      v-if="hoveredChecksAdapter?.checks?.length"
      class="fixed z-[9999] bg-surface-secondary rounded-xl p-16 shadow-card border border-line-subtle overflow-y-auto overflow-x-hidden"
      :style="[tooltipStyle, { width: `${TOOLTIP_WIDTH}px` }]"
      @mouseenter="onTooltipMouseEnter"
      @mouseleave="onTooltipMouseLeave"
    >
      <p class="text-p3 font-medium text-content-primary mb-12">
        Checks
      </p>
      <div class="flex flex-col gap-10">
        <div
          v-for="check in hoveredChecksAdapter.checks"
          :key="check.id"
          class="flex items-start gap-10"
        >
          <span
            class="flex-shrink-0 w-20 h-20 rounded-full flex items-center justify-center mt-8"
            :class="check.pass ? 'bg-success-500' : 'bg-error-500'"
          >
            <SvgIcon
              :name="check.pass ? 'check' : 'x'"
              class="!w-10 !h-10 text-white"
            />
          </span>
          <div>
            <p class="text-p3 font-medium text-content-primary">
              {{ check.id }}
            </p>
            <p class="text-p3 text-content-secondary break-words">
              {{ check.message }}
            </p>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
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
