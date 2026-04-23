<script setup lang="ts">
import { autoLink } from '~/utils/autoLink'

defineProps<{ reason: string }>()
</script>

<template>
  <div class="w-full rounded-12 p-16 bg-warning-100 text-warning-500">
    <div class="flex items-center gap-8">
      <SvgIcon
        name="warning"
        class="!w-20 !h-20 flex-shrink-0"
      />
      <!-- eslint-disable vue/no-v-html -- deprecationReason is validated server-side in server/api/labels/[file].get.ts -->
      <p
        v-if="reason"
        class="text-p3 text-warning-500 auto-link"
        v-html="autoLink(reason)"
      />
      <!-- eslint-enable vue/no-v-html -->
      <p
        v-else
        class="text-p3 text-warning-500"
      >
        This vault has been deprecated.
      </p>
    </div>
  </div>
</template>
