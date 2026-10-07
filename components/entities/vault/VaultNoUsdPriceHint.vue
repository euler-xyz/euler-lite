<script setup lang="ts">
import type { Placement } from '@floating-ui/vue'

withDefaults(defineProps<{ placement?: Placement }>(), {
  placement: 'top',
})
</script>

<template>
  <UiHoverPreviewTooltip
    title="No USD price"
    text="This asset has no USD price right now, so amounts show in tokens."
    :placement="placement"
    icon-class="text-warning-500"
  />
</template>
