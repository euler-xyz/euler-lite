<script setup lang="ts">
import type { ExternalMigrationCandidate } from '~/composables/useExternalMigrationPositions'
import { formatExactAmount, formatUsdValue } from '~/utils/string-utils'
import { roundAndCompactTokens } from '~/utils/crypto-utils'

type MigrationAsset = {
  address: string
  symbol: string
  decimals: number
  amount: bigint
  amountUsd: number | null
}

const props = defineProps<{
  position: ExternalMigrationCandidate
  loading?: boolean
  disabledReason?: string
  showAction?: boolean
  hoverable?: boolean
}>()

const emit = defineEmits<{
  migrate: []
}>()

const sourceLabel = computed(() => props.position.protocol === 'Morpho' ? 'Morpho' : props.position.protocol)
const collateralAssets = computed<MigrationAsset[]>(() => [props.position.collateral])
const debtAssets = computed<MigrationAsset[]>(() => {
  const debt = props.position.debt
  return debt && debt.amount > 0n ? [debt] : []
})
const isDisabled = computed(() => !!props.disabledReason)
const isBorrow = computed(() => debtAssets.value.length > 0)

const collateralLabel = computed(() => isBorrow.value ? 'Collateral' : 'Deposited')

const netAssetValueDisplay = computed(() => {
  const collateralUsd = collateralAssets.value[0]?.amountUsd ?? null
  const debtUsd = debtAssets.value[0]?.amountUsd ?? null
  if (collateralUsd === null || debtUsd === null) return '-'
  return formatUsdValue(collateralUsd - debtUsd)
})

const pairLabel = computed(() => {
  const collateral = collateralAssets.value.map(asset => asset.symbol).join(', ')
  const debt = debtAssets.value.map(asset => asset.symbol).join(', ')
  return debt ? `${collateral}/${debt}` : collateral
})

// Header avatar: overlap collateral + debt for borrow positions, single mark for supply.
const headerAvatarAsset = computed(() =>
  isBorrow.value
    ? [props.position.collateral, ...debtAssets.value]
    : props.position.collateral,
)

const assetHasPrice = (asset: MigrationAsset) => asset.amountUsd !== null
const assetUsd = (asset: MigrationAsset) =>
  asset.amountUsd === null ? '-' : formatUsdValue(asset.amountUsd)
const assetTokens = (asset: MigrationAsset) =>
  `${roundAndCompactTokens(asset.amount, asset.decimals)} ${asset.symbol}`
const assetExact = (asset: MigrationAsset) =>
  formatExactAmount(asset.amount, asset.decimals, asset.symbol)

const visibleAssets = (assets: MigrationAsset[]) => assets.slice(0, 2)
const hiddenAssetCount = (assets: MigrationAsset[]) => Math.max(assets.length - 2, 0)

const describeAssets = (assets: MigrationAsset[]) =>
  assets.length
    ? assets.map(asset => assetTokens(asset)).join(', ')
    : 'supply only'

const rowAriaLabel = computed(() =>
  isBorrow.value
    ? `${sourceLabel.value} position. Collateral ${describeAssets(collateralAssets.value)}. Debt ${describeAssets(debtAssets.value)}.`
    : `${sourceLabel.value} position. Deposited ${describeAssets(collateralAssets.value)}.`,
)

const buttonAriaLabel = computed(() => {
  const collateral = collateralAssets.value.map(asset => asset.symbol).join(', ')
  const debt = debtAssets.value.map(asset => asset.symbol).join(', ')
  return debt
    ? `Migrate ${sourceLabel.value} ${collateral} collateral and ${debt} debt to Euler`
    : `Migrate ${sourceLabel.value} ${collateral} supply to Euler`
})

const handleMigrate = () => {
  if (isDisabled.value || props.loading) return
  emit('migrate')
}
</script>

<template>
  <article
    class="portfolio-migrate-row block no-underline bg-surface rounded-xl border border-line-subtle shadow-card"
    :class="hoverable !== false ? 'transition-all duration-default ease-default hover:shadow-card-hover hover:border-line-emphasis' : ''"
    role="group"
    :aria-label="rowAriaLabel"
    data-id="portfolio-list-item"
    data-list="migrate"
    :data-key="position.id"
  >
    <div class="flex items-center gap-12 py-16 px-16 pb-12 border-b border-line-default">
      <AssetAvatar
        :asset="headerAvatarAsset"
        size="40"
      />
      <div class="flex-grow min-w-0">
        <div class="text-content-tertiary text-p3 mb-4 truncate">
          {{ sourceLabel }}
        </div>
        <div
          class="text-h5 text-content-primary truncate"
          :title="pairLabel"
        >
          {{ pairLabel }}
        </div>
      </div>
    </div>

    <div class="flex flex-col gap-12 py-12 px-16 pb-16">
      <div
        v-if="isBorrow"
        class="flex justify-between gap-16"
      >
        <div class="text-content-tertiary text-p3">
          Net asset value
        </div>
        <div class="text-content-primary text-p3 text-right">
          {{ netAssetValueDisplay }}
        </div>
      </div>

      <div class="flex justify-between gap-16">
        <div class="text-content-tertiary text-p3">
          {{ collateralLabel }}
        </div>
        <div class="flex flex-col items-end gap-6 min-w-0 text-right">
          <div
            v-for="asset in visibleAssets(collateralAssets)"
            :key="`${asset.address}-collateral`"
            class="flex justify-end items-baseline gap-8 min-w-0"
          >
            <div class="text-content-primary text-p3">
              {{ assetHasPrice(asset) ? assetUsd(asset) : assetTokens(asset) }}
            </div>
            <UiExactAmount
              v-if="assetHasPrice(asset)"
              class="text-content-tertiary text-p3"
              :exact="assetExact(asset)"
            >
              ~ {{ assetTokens(asset) }}
            </UiExactAmount>
          </div>
          <div
            v-if="hiddenAssetCount(collateralAssets)"
            class="text-content-tertiary text-p3"
          >
            +{{ hiddenAssetCount(collateralAssets) }} more
          </div>
        </div>
      </div>

      <div
        v-if="isBorrow"
        class="flex justify-between gap-16"
      >
        <div class="text-content-tertiary text-p3">
          Debt
        </div>
        <div class="flex flex-col items-end gap-6 min-w-0 text-right">
          <div
            v-for="asset in visibleAssets(debtAssets)"
            :key="`${asset.address}-debt`"
            class="flex justify-end items-baseline gap-8 min-w-0"
          >
            <div class="text-content-primary text-p3">
              {{ assetHasPrice(asset) ? assetUsd(asset) : assetTokens(asset) }}
            </div>
            <UiExactAmount
              v-if="assetHasPrice(asset)"
              class="text-content-tertiary text-p3"
              :exact="assetExact(asset)"
            >
              ~ {{ assetTokens(asset) }}
            </UiExactAmount>
          </div>
          <div
            v-if="hiddenAssetCount(debtAssets)"
            class="text-content-tertiary text-p3"
          >
            +{{ hiddenAssetCount(debtAssets) }} more
          </div>
        </div>
      </div>

      <div
        v-if="showAction !== false"
        class="mt-4 flex flex-wrap items-center gap-8 laptop:flex-nowrap laptop:[&>*]:whitespace-nowrap"
        :title="disabledReason"
        @click.stop
      >
        <UiButton
          class="portfolio-migrate-row__button w-full"
          rounded
          :loading="loading"
          :disabled="isDisabled"
          :aria-label="buttonAriaLabel"
          @click="handleMigrate"
        >
          Migrate
        </UiButton>
        <span
          v-if="disabledReason"
          class="portfolio-migrate-row__hint w-full text-content-muted text-p3 text-center"
        >
          {{ disabledReason }}
        </span>
      </div>
    </div>
  </article>
</template>

<style scoped lang="scss">
.portfolio-migrate-row {
  overflow: hidden;

  &__hint {
    margin-top: 2px;
  }
}
</style>
