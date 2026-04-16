<script setup lang="ts">
import { vaultTypeDescriptions } from '~/entities/vault/descriptions'

defineEmits(['close'])
</script>

<template>
  <BaseModalWrapper
    title="Limited Risk Management"
    @close="$emit('close')"
  >
    <div class="flex flex-col gap-16 pt-8">
      <div class="flex items-center justify-center">
        <div class="flex items-center justify-center w-48 h-48 rounded-12 bg-accent-100">
          <SvgIcon
            name="pulse"
            class="!w-24 !h-24 text-accent-600"
          />
        </div>
      </div>

      <div class="flex flex-col gap-8">
        <p class="text-p2 text-content-primary text-center font-medium">
          Limited Risk Management
        </p>
        <p class="text-p3 text-content-secondary text-center">
          {{ vaultTypeDescriptions.governanceLimited }}
        </p>
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
