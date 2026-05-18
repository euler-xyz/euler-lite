<script setup lang="ts">
import type { SecuritizeCollateralVault, EVault, OracleAdapterEntry } from '@eulerxyz/euler-v2-sdk'
import { getChecksStatus, OracleAdapterCheckSeverity, type OracleAdapterMeta } from '~/entities/oracle'
import { getOracleProviderLogo } from '~/entities/oracle-providers'
import { getExplorerLink } from '~/utils/block-explorer'
import { formatNumber } from '~/utils/string-utils'
import { shouldInvertOraclePrice } from '~/utils/oracle-label'
import { useOracleAdapterPrices } from '~/composables/useOracleAdapterPrices'
import type { CSSProperties } from 'vue'

const props = defineProps<{
  vault?: EVault
  vaults?: EVault[]
  collateralVaults?: (EVault | SecuritizeCollateralVault)[]
}>()
const { oracleAdapters, loadOracleAdapter } = useEulerLabels()
const { chainId } = useEulerAddresses()
const { buildKnownSymbols, resolveSymbol: resolveTokenSymbol, shortenAddress } = useTokenSymbolResolver()
const { copyToClipboard, isCopied } = useClipboardCopy()

const sourceVaults = computed(() => {
  if (props.vaults?.length) {
    return props.vaults
  }

  if (props.vault) {
    return [props.vault]
  }

  return []
})

const getCollateralAdapters = (vault: EVault, collateralVault: EVault | SecuritizeCollateralVault) =>
  vault.collaterals.find(collateral =>
    collateral.address.toLowerCase() === collateralVault.address.toLowerCase(),
  )?.oracleAdapters ?? []

const adapters = computed(() => {
  const entries: OracleAdapterEntry[] = []
  const deduped = new Map<string, OracleAdapterEntry>()

  sourceVaults.value.forEach((vault) => {
    entries.push(...vault.debtPricingOracleAdapters)

    if (props.collateralVaults?.length) {
      props.collateralVaults.forEach((collateralVault) => {
        entries.push(...getCollateralAdapters(vault, collateralVault))
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
    if (vault.unitOfAccount) {
      map.set(vault.unitOfAccount.address.toLowerCase(), vault.unitOfAccount.symbol)
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
  const invertPrice = shouldInvertOraclePrice({
    metaBase: meta?.base,
    metaQuote: meta?.quote,
    callerBase: adapter.base,
    callerQuote: adapter.quote,
  })

  return {
    ...adapter,
    name,
    provider,
    methodology: meta?.methodology || (isERC4626 ? 'Exchange Rate' : undefined),
    logo: getOracleProviderLogo(provider, name),
    label: meta?.label
      ? {
          primary: meta.label.split('(')[0].trimEnd(),
          suffix: meta.label.includes('(') ? meta.label.slice(meta.label.indexOf('(')).trim() : undefined,
        }
      : undefined,
    invertPrice,
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

const onCopyClick = (address: string, key = address) => {
  copyToClipboard(address, key)
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

const formatAdapterPrice = (adapter: OracleAdapterEntry & { invertPrice: boolean }) => {
  const key = getAdapterKey(adapter)
  const info = adapterPrices.value.get(key)
  if (!info?.success) return '-'
  const rate = adapter.invertPrice && info.rate > 0 ? 1 / info.rate : info.rate
  return formatNumber(rate, 4)
}

const hoveredChecksAdapter = ref<(typeof adapterViews.value)[0] | null>(null)
const tooltipStyle = ref<CSSProperties>({})
const TOOLTIP_WIDTH = 520
let hideTimer: ReturnType<typeof setTimeout> | null = null

const isMobile = ref(false)
const updateIsMobile = () => {
  isMobile.value = window.innerWidth < 768
}
onMounted(() => {
  updateIsMobile()
  window.addEventListener('resize', updateIsMobile)
})
onUnmounted(() => {
  window.removeEventListener('resize', updateIsMobile)
  if (hideTimer) clearTimeout(hideTimer)
})

// ── Bottom sheet swipe-to-close (mirrors BaseModalWrapper) ───────────────────
const sheetEl = ref<HTMLElement>()
const sheetDragY = ref(0)
let sheetStartY = 0

const onSheetPointerDown = (e: PointerEvent) => {
  if (e.pointerType !== 'touch') return
  sheetStartY = e.clientY
  sheetDragY.value = 0
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}
const onSheetPointerMove = (e: PointerEvent) => {
  if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
  sheetDragY.value = Math.max(0, e.clientY - sheetStartY)
}
const onSheetPointerUp = (e: PointerEvent) => {
  if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
  if (sheetDragY.value > 80) hoveredChecksAdapter.value = null
  sheetDragY.value = 0
}
const onSheetPointerCancel = () => {
  sheetDragY.value = 0
}

const isTouchTargetScrolled = (target: EventTarget | null): boolean => {
  let el = target as HTMLElement | null
  while (el && el !== sheetEl.value) {
    if (el.scrollTop > 0) return true
    el = el.parentElement
  }
  return false
}

let scrollTouchStartY = 0
let scrollGestureDecided = false
let scrollDragActive = false

const onScrollTouchStart = (e: TouchEvent) => {
  scrollTouchStartY = e.touches[0].clientY
  scrollGestureDecided = false
  scrollDragActive = false
}
const onScrollTouchMove = (e: TouchEvent) => {
  const delta = e.touches[0].clientY - scrollTouchStartY
  if (!scrollGestureDecided) {
    scrollGestureDecided = true
    if (delta > 0 && !isTouchTargetScrolled(e.target)) scrollDragActive = true
  }
  if (!scrollDragActive) return
  e.preventDefault()
  sheetDragY.value = Math.max(0, delta)
}
const onScrollTouchEnd = () => {
  scrollGestureDecided = false
  if (!scrollDragActive) return
  scrollDragActive = false
  if (sheetDragY.value > 80) hoveredChecksAdapter.value = null
  sheetDragY.value = 0
}
const onScrollTouchCancel = () => {
  scrollGestureDecided = false
  scrollDragActive = false
  sheetDragY.value = 0
}

const sheetDragStyle = computed(() => ({
  transform: sheetDragY.value ? `translateY(${sheetDragY.value}px)` : undefined,
  transition: sheetDragY.value ? 'none' : 'transform 0.3s ease',
}))

const onChecksClick = (adapter: (typeof adapterViews.value)[0], event?: MouseEvent | KeyboardEvent) => {
  if (!adapter.checks?.length) return
  if (hoveredChecksAdapter.value === adapter) {
    hoveredChecksAdapter.value = null
    return
  }
  // On desktop, position the tooltip using the trigger element's bounding rect
  if (!isMobile.value && event?.currentTarget) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const left = Math.min(rect.left, window.innerWidth - TOOLTIP_WIDTH - 16)
    const spaceBelow = window.innerHeight - rect.bottom - 16
    const spaceAbove = rect.top - 16
    const flipUp = spaceAbove > spaceBelow
    tooltipStyle.value = flipUp
      ? { top: `${rect.top - 8}px`, left: `${left}px`, transform: 'translateY(-100%)', maxHeight: `${spaceAbove}px` }
      : { top: `${rect.bottom + 8}px`, left: `${left}px`, transform: 'none', maxHeight: `${spaceBelow}px` }
  }
  hoveredChecksAdapter.value = adapter
}

const onChecksMouseEnter = (adapter: (typeof adapterViews.value)[0], event: MouseEvent) => {
  if (isMobile.value || !adapter.checks?.length) return
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
  if (isMobile.value) return
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
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 sm:gap-8">
          <div class="p2 text-content-primary">
            <template v-if="adapter.label">
              {{ adapter.label.primary }}
              <span
                v-if="adapter.label.suffix"
                class="text-content-tertiary ml-2"
              >{{ adapter.label.suffix }}</span>
            </template>
            <template v-else>
              {{ resolveSymbol(adapter.base) }}/{{ resolveSymbol(adapter.quote) }}
            </template>
          </div>
          <div class="flex items-center gap-8 flex-shrink-0">
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
              aria-label="Copy address"
              @click="onCopyClick(adapter.oracle, getAdapterKey(adapter))"
            >
              <SvgIcon
                class="!w-18 !h-18"
                :name="isCopied(getAdapterKey(adapter)) ? 'check' : 'copy'"
              />
            </button>
          </div>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-12 text-p3">
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
          <div class="flex flex-col gap-4 order-3 md:order-2">
            <span class="text-content-tertiary">Methodology</span>
            <span class="text-content-primary">{{ adapter.methodology || 'Unknown' }}</span>
          </div>
          <div
            class="flex flex-col gap-4 order-4 md:order-3"
            :role="adapter.checks?.length ? 'button' : undefined"
            :tabindex="adapter.checks?.length ? 0 : undefined"
            @mouseenter="onChecksMouseEnter(adapter, $event)"
            @mouseleave="onChecksMouseLeave"
            @click.stop="onChecksClick(adapter, $event)"
            @keydown.enter.stop="onChecksClick(adapter, $event)"
            @keydown.space.stop.prevent="onChecksClick(adapter, $event)"
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
          <div class="flex flex-col gap-4 order-2 md:order-4">
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
            v-for="(check, i) in adapter.failedChecks"
            :key="`${check.id}-${i}`"
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
    <template v-if="hoveredChecksAdapter?.checks?.length">
      <!-- Mobile backdrop -->
      <div
        v-if="isMobile"
        class="fixed inset-0 z-[9998] bg-black/50"
        @click="hoveredChecksAdapter = null"
      />
      <!-- Tooltip (desktop) / Bottom sheet (mobile) -->
      <div
        ref="sheetEl"
        class="fixed z-[9999] bg-surface-secondary border border-line-subtle overflow-x-hidden"
        :class="isMobile
          ? 'bottom-0 left-0 right-0 rounded-t-2xl max-h-[70vh] shadow-card flex flex-col'
          : 'rounded-xl p-16 shadow-card overflow-y-auto'"
        :style="isMobile ? sheetDragStyle : [tooltipStyle, { width: `${TOOLTIP_WIDTH}px` }]"
        @mouseenter="onTooltipMouseEnter"
        @mouseleave="onTooltipMouseLeave"
      >
        <!-- Drag handle zone (mobile only) -->
        <div
          v-if="isMobile"
          class="shrink-0 px-24 pt-12 touch-none select-none"
          @pointerdown="onSheetPointerDown"
          @pointermove="onSheetPointerMove"
          @pointerup="onSheetPointerUp"
          @pointercancel="onSheetPointerCancel"
        >
          <div class="w-32 h-4 rounded-full bg-line-subtle mx-auto mb-16" />
          <p class="text-p3 font-medium text-content-primary mb-12">
            Checks
          </p>
        </div>
        <p
          v-else
          class="text-p3 font-medium text-content-primary mb-12"
        >
          Checks
        </p>
        <!-- Scroll container -->
        <div
          class="flex flex-col gap-10 overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          :class="isMobile ? 'px-24 pb-24' : ''"
          @touchstart.passive="onScrollTouchStart"
          @touchmove="onScrollTouchMove"
          @touchend.passive="onScrollTouchEnd"
          @touchcancel.passive="onScrollTouchCancel"
        >
          <div
            v-for="(check, i) in hoveredChecksAdapter.checks"
            :key="`${check.id}-${i}`"
            class="flex items-start gap-10"
          >
            <span
              class="flex-shrink-0 w-20 h-20 rounded-full flex items-center justify-center mt-8"
              :class="{
                'bg-success-500': check.pass,
                'bg-error-500': !check.pass && check.severity === OracleAdapterCheckSeverity.High,
                'bg-warning-500': !check.pass && check.severity !== OracleAdapterCheckSeverity.High,
              }"
            >
              <SvgIcon
                :name="check.pass ? 'check' : 'x'"
                class="!w-10 !h-10 text-white"
              />
            </span>
            <div class="min-w-0">
              <p class="text-p3 font-medium text-content-primary break-words">
                {{ check.id }}
              </p>
              <p class="text-p3 text-content-secondary break-words">
                {{ check.message }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </template>
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

  &:focus-visible {
    outline: 2px solid var(--color-accent-600);
    outline-offset: 2px;
    border-radius: 4px;
  }
}
</style>
