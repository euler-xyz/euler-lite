<script setup lang="ts">
defineEmits<{ close: [] }>()

const bullets = [
  'Borrowers pay a fixed rate during the cycle and can repay at any time without penalty',
  'Lenders can only withdraw when liquidity is available, typically at the end of each cycle',
  'The rate rises sharply during the repayment window, creating an incentive to repay and a structured exit point for lenders',
  'Cycles repeat indefinitely — no manual rollover is required',
]
</script>

<template>
  <UiInfoModal
    title="Cyclical Note"
    icon="refresh"
    headline="Fixed rates with recurring cycles"
    body="Cyclical Notes offer borrowers a fixed interest rate for most of the cycle, followed by a short repayment window with a sharply higher rate to incentivise repayment. For lenders, withdrawals may be limited during the cycle."
    :bullets="bullets"
    @close="$emit('close')"
  />
</template>
