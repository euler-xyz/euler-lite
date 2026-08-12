<script setup lang="ts">
import { autoLink } from '~/utils/autoLink'
import { stopLinkPropagation } from '~/utils/stopLinkPropagation'

defineProps<{ notice: string }>()
</script>

<template>
  <div
    v-if="notice"
    class="flex items-center gap-8 bg-accent-100 border border-accent-300 rounded-12 p-12"
  >
    <SvgIcon
      name="info-circle"
      class="!w-20 !h-20 text-accent-600 shrink-0"
    />
    <!-- eslint-disable vue/no-v-html -- autoLink escapes label text before adding links -->
    <span
      class="text-accent-700 text-p4 auto-link"
      @click="stopLinkPropagation"
      v-html="autoLink(notice)"
    />
    <!-- eslint-enable vue/no-v-html -->
  </div>
</template>
