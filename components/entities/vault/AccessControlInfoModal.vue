<script setup lang="ts">
defineEmits(['close'])
</script>

<template>
  <BaseModalWrapper
    title="Access-controlled Vault"
    @close="$emit('close')"
  >
    <div class="flex flex-col gap-16 pt-8">
      <div class="flex items-center justify-center">
        <div class="flex items-center justify-center w-48 h-48 rounded-12 bg-accent-100">
          <SvgIcon
            name="search-user"
            class="!w-24 !h-24 text-accent-600"
          />
        </div>
      </div>

      <div class="flex flex-col gap-8">
        <p class="text-p2 text-content-primary text-center font-medium">
          Permissioned Operations
        </p>
        <p class="text-p3 text-content-secondary text-center">
          This vault routes operations through an access-control hook. Only addresses on an on-chain allowlist can perform the gated operations.
        </p>
      </div>

      <div class="flex flex-col gap-8 p-12 rounded-12 bg-surface-secondary">
        <div class="flex items-start gap-8">
          <SvgIcon
            name="check-circle"
            class="!w-16 !h-16 text-accent-600 mt-2 shrink-0"
          />
          <p class="text-p3 text-content-secondary">
            Access is granted by the vault manager — there is no self-service verification
          </p>
        </div>
        <div class="flex items-start gap-8">
          <SvgIcon
            name="check-circle"
            class="!w-16 !h-16 text-accent-600 mt-2 shrink-0"
          />
          <p class="text-p3 text-content-secondary">
            If your address is not whitelisted, the gated operations will revert
          </p>
        </div>
        <div class="flex items-start gap-8">
          <SvgIcon
            name="check-circle"
            class="!w-16 !h-16 text-accent-600 mt-2 shrink-0"
          />
          <p class="text-p3 text-content-secondary">
            Which operations are gated depends on the vault's hook configuration
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
