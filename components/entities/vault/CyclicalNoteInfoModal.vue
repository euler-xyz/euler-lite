<script setup lang="ts">
defineEmits<{ close: [] }>()
</script>

<template>
  <BaseModalWrapper
    title="Cyclical Note"
    @close="$emit('close')"
  >
    <div class="flex flex-col gap-16 pt-8">
      <div class="flex items-center justify-center">
        <div class="flex items-center justify-center w-48 h-48 rounded-12 bg-accent-100">
          <SvgIcon
            name="refresh"
            class="!w-24 !h-24 text-accent-600"
          />
        </div>
      </div>

      <div class="flex flex-col gap-8">
        <p class="text-p2 text-content-primary text-center font-medium">
          Fixed rates with recurring cycles
        </p>
        <p class="text-p3 text-content-secondary text-center">
          Cyclical Notes offer borrowers a fixed interest rate for most of the cycle, followed by a short repayment window with a sharply higher rate to incentivise repayment. Lenders earn an elevated, predictable yield in exchange for reduced withdrawal flexibility.
        </p>
      </div>

      <div class="flex flex-col gap-8 p-12 rounded-12 bg-surface-secondary">
        <div class="flex items-start gap-8">
          <SvgIcon
            name="check-circle"
            class="!w-16 !h-16 text-accent-600 mt-2 shrink-0"
          />
          <p class="text-p3 text-content-secondary">
            Borrowers pay a fixed rate during the cycle and can repay at any time without penalty
          </p>
        </div>
        <div class="flex items-start gap-8">
          <SvgIcon
            name="check-circle"
            class="!w-16 !h-16 text-accent-600 mt-2 shrink-0"
          />
          <p class="text-p3 text-content-secondary">
            Lenders can only withdraw when liquidity is available, typically at the end of each cycle
          </p>
        </div>
        <div class="flex items-start gap-8">
          <SvgIcon
            name="check-circle"
            class="!w-16 !h-16 text-accent-600 mt-2 shrink-0"
          />
          <p class="text-p3 text-content-secondary">
            The rate rises sharply during the repayment window, creating an incentive to repay and a structured exit point for lenders
          </p>
        </div>
        <div class="flex items-start gap-8">
          <SvgIcon
            name="check-circle"
            class="!w-16 !h-16 text-accent-600 mt-2 shrink-0"
          />
          <p class="text-p3 text-content-secondary">
            Cycles repeat indefinitely — no manual rollover is required
          </p>
        </div>
      </div>

      <UiButton
        variant="primary"
        size="large"
        @click="$emit('close')"
      >
        Got it
      </UiButton>
    </div>
  </BaseModalWrapper>
</template>
