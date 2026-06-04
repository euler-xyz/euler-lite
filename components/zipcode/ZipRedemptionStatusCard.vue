<script setup lang="ts">
import { formatZipUsd, formatUsdc, formatEpochRange, formatDate } from '~/types/zipcode'

// Redemption status card with queued / partial / claimable / claimed states
// (spec §10.5). Emits `claim` and `fast-exit`; the page wires the flows.
defineEmits<{ (e: 'claim' | 'fast-exit'): void }>()
withDefaults(defineProps<{ showFastExit?: boolean }>(), { showFastExit: false })

const { activeRedemptionRequest, hasRedemptionRequest } = useZipDemo()
const req = activeRedemptionRequest
</script>

<template>
  <div class="zip-card p-24">
    <div class="flex items-center justify-between gap-12 mb-16">
      <h3 class="zip-display text-[20px]">
        Redemption status
      </h3>
      <ZipStatusBadge :status="req.status" />
    </div>

    <div
      v-if="!hasRedemptionRequest"
      class="text-[15px]"
      style="color: var(--zip-text-muted)"
    >
      No active redemption. Request one from your portfolio to enter the epoch queue.
    </div>

    <!-- Queued -->
    <dl
      v-else-if="req.status === 'queued'"
      class="flex flex-col gap-12"
    >
      <div class="flex items-center justify-between">
        <dt style="color: var(--zip-text-muted)">
          Queued
        </dt>
        <dd class="font-semibold tabular-nums">
          {{ formatZipUsd(req.zipUsdRequested) }}
        </dd>
      </div>
      <div class="flex items-center justify-between">
        <dt style="color: var(--zip-text-muted)">
          Current epoch
        </dt>
        <dd class="tabular-nums">
          {{ formatEpochRange(req.epochStart, req.epochEnd) }}
        </dd>
      </div>
      <div class="flex items-center justify-between">
        <dt style="color: var(--zip-text-muted)">
          Settlement date
        </dt>
        <dd class="tabular-nums">
          {{ formatDate(req.epochEnd) }}
        </dd>
      </div>
    </dl>

    <!-- Partially settled -->
    <div v-else-if="req.status === 'partially-settled'">
      <dl class="flex flex-col gap-12">
        <div class="flex items-center justify-between">
          <dt style="color: var(--zip-text-muted)">
            Requested
          </dt>
          <dd class="font-semibold tabular-nums">
            {{ formatZipUsd(req.zipUsdRequested) }}
          </dd>
        </div>
        <div class="flex items-center justify-between">
          <dt style="color: var(--zip-text-muted)">
            Claimable
          </dt>
          <dd class="font-semibold tabular-nums">
            {{ formatUsdc(req.usdcClaimable) }}
          </dd>
        </div>
        <div class="flex items-center justify-between">
          <dt style="color: var(--zip-text-muted)">
            Carried to next epoch
          </dt>
          <dd class="tabular-nums">
            {{ formatZipUsd(req.zipUsdCarriedForward) }}
          </dd>
        </div>
      </dl>
      <UiButton
        class="mt-20 w-full"
        @click="$emit('claim')"
      >
        Claim {{ formatUsdc(req.usdcClaimable) }}
      </UiButton>
    </div>

    <!-- Fully claimable -->
    <div v-else-if="req.status === 'claimable'">
      <p
        class="text-[13px]"
        style="color: var(--zip-text-muted)"
      >
        Claimable
      </p>
      <p class="text-[32px] font-semibold tabular-nums">
        {{ formatUsdc(req.usdcClaimable) }}
      </p>
      <UiButton
        class="mt-16 w-full"
        @click="$emit('claim')"
      >
        Claim USDC
      </UiButton>
    </div>

    <!-- Claimed -->
    <div
      v-else
      class="flex items-center gap-10 text-[15px]"
    >
      <SvgIcon
        name="check"
        class="w-20 h-20"
        style="color: var(--zip-brand-strong)"
      />
      Redemption claimed. Funds delivered to your digital-dollar balance.
    </div>

    <button
      v-if="showFastExit && hasRedemptionRequest && (req.status === 'queued' || req.status === 'partially-settled')"
      type="button"
      class="mt-16 text-[13px] underline underline-offset-2"
      style="color: var(--zip-info)"
      @click="$emit('fast-exit')"
    >
      Need liquidity sooner?
    </button>
  </div>
</template>
