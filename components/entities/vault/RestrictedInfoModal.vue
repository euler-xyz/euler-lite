<script setup lang="ts">
type Variant = 'blocked' | 'restricted'

const { variant = 'blocked' } = defineProps<{ variant?: Variant }>()

defineEmits<{ close: [] }>()

const title = computed(() => variant === 'restricted' ? 'Asset Restricted' : 'Region Restricted')
const headline = computed(() => variant === 'restricted' ? 'Asset restricted in your region' : 'Not available in your region')
const body = computed(() =>
  variant === 'restricted'
    ? 'This asset is restricted for users in your region. You can still reduce existing exposure — for example, by repaying an open position — but you cannot acquire more of this asset through Euler.'
    : 'This vault is not available for users in your region. You cannot supply, borrow, or acquire new exposure here. Existing positions can still be withdrawn or repaid.',
)
</script>

<template>
  <UiInfoModal
    :title="title"
    icon="warning"
    icon-tone="warning"
    :headline="headline"
    :body="body"
    @close="$emit('close')"
  />
</template>
