<script setup lang="ts">
type Variant = 'blocked' | 'restricted'

const { variant = 'blocked' } = defineProps<{ variant?: Variant }>()

defineEmits(['close'])

const title = computed(() => variant === 'restricted' ? 'Asset Restricted' : 'Region Restricted')
const headline = computed(() => variant === 'restricted' ? 'Asset restricted in your region' : 'Not available in your region')
const body = computed(() =>
  variant === 'restricted'
    ? 'This asset is restricted for users in your region. You can still reduce existing exposure — for example, by repaying an open position — but you cannot acquire more of this asset through Euler.'
    : 'This vault is not available for users in your region. You cannot supply, borrow, or acquire new exposure here. Existing positions can still be withdrawn or repaid.',
)
</script>

<template>
  <BaseModalWrapper
    :title="title"
    @close="$emit('close')"
  >
    <div class="flex flex-col gap-16 pt-8">
      <div class="flex items-center justify-center">
        <div class="flex items-center justify-center w-48 h-48 rounded-12 bg-warning-100">
          <SvgIcon
            name="warning"
            class="!w-24 !h-24 text-warning-500"
          />
        </div>
      </div>

      <div class="flex flex-col gap-8">
        <p class="text-p2 text-content-primary text-center font-medium">
          {{ headline }}
        </p>
        <p class="text-p3 text-content-secondary text-center">
          {{ body }}
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
