<script setup lang="ts">
import { formatNumber, formatSmartAmount, formatHealthScore } from '~/utils/string-utils'
import { formatLiquidationBuffer as formatLiqBuffer } from '~/utils/repayUtils'
import { nanoToValue } from '~/utils/crypto-utils'
import type { useCollateralForm } from '~/composables/position/useCollateralForm'

// Shared position summary card used by the collateral supply/withdraw forms.
// Both drive off the same `useCollateralForm` shape, so the whole form object
// is passed through. The two per-page differences are exposed as props:
//  - `visible`: the wrapping `v-if` (supply gates on position only, withdraw
//    additionally requires a borrow vault).
//  - `excludeInfiniteLiqPrice`: supply hides the current liq. price when it is
//    `Infinity`; withdraw shows it whenever it is non-null.
const props = defineProps<{
  form: ReturnType<typeof useCollateralForm>
  visible: boolean
  excludeInfiniteLiqPrice?: boolean
}>()

const form = props.form
</script>

<template>
  <VaultFormInfoBlock
    v-if="visible"
    :loading="form.isEstimatesLoading.value"
    variant="card"
    class="w-full laptop:max-w-[360px]"
  >
    <SummaryRow label="Net APY">
      <SummaryValue
        :before="form.netAPY.value !== null ? formatNumber(form.netAPY.value) : undefined"
        :after="form.estimateNetAPY.value !== null ? formatNumber(form.estimateNetAPY.value) : undefined"
        suffix="%"
      />
    </SummaryRow>
    <SummaryRow label="Oracle price">
      <SummaryPriceValue
        :value="!form.priceFixed.value.isZero() ? formatSmartAmount(form.priceInvert.invertValue(form.priceFixed.value.toUnsafeFloat())) : undefined"
        :symbol="form.priceInvert.displaySymbol"
        invertible
        @invert="form.priceInvert.toggle"
      />
    </SummaryRow>
    <SummaryRow label="Liq. price">
      <SummaryPriceValue
        :before="form.liquidationPrice.value != null && (!excludeInfiniteLiqPrice || form.liquidationPrice.value !== Infinity) ? formatSmartAmount(form.priceInvert.invertValue(form.liquidationPrice.value)!) : undefined"
        :after="form.estimateLiquidationPrice.value != null ? formatSmartAmount(form.priceInvert.invertValue(form.estimateLiquidationPrice.value)!) : undefined"
        :symbol="form.priceInvert.displaySymbol"
        invertible
        @invert="form.priceInvert.toggle"
      />
    </SummaryRow>
    <SummaryRow label="Liq. buffer">
      <SummaryValue
        :before="formatLiqBuffer(form.priceInvert.invertValue(form.priceFixed.value.toUnsafeFloat()), form.priceInvert.invertValue(form.liquidationPrice.value))"
        :after="formatLiqBuffer(form.priceInvert.invertValue(form.priceFixed.value.toUnsafeFloat()), form.priceInvert.invertValue(form.estimateLiquidationPrice.value))"
        suffix="%"
      />
    </SummaryRow>
    <SummaryRow label="LTV">
      <SummaryValue
        :before="formatNumber(ltvToPercent(nanoToValue(form.position.value.userLTV ?? form.position.value.currentLTV ?? 0n, 18)))"
        :after="formatNumber(nanoToValue(form.estimateUserLTV.value, 18))"
        suffix="%"
      />
    </SummaryRow>
    <SummaryRow label="Health score">
      <SummaryValue
        :before="formatHealthScore(nanoToValue(form.position.value.healthFactor ?? 0n, 18))"
        :after="formatHealthScore(nanoToValue(form.estimateHealth.value, 18))"
      />
    </SummaryRow>
  </VaultFormInfoBlock>
</template>
