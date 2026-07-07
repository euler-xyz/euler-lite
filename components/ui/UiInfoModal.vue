<script setup lang="ts">
const {
  iconTone = 'accent',
  bullets = [],
} = defineProps<{
  title: string
  icon: string
  iconTone?: 'accent' | 'warning'
  headline: string
  body: string
  bullets?: string[]
}>()

defineEmits<{ close: [] }>()
</script>

<template>
  <BaseModalWrapper
    :title="title"
    @close="$emit('close')"
  >
    <div class="flex flex-col gap-16 pt-8">
      <div class="flex items-center justify-center">
        <div
          class="flex items-center justify-center w-48 h-48 rounded-12"
          :class="iconTone === 'warning' ? 'bg-warning-100' : 'bg-accent-100'"
        >
          <SvgIcon
            :name="icon"
            class="!w-24 !h-24"
            :class="iconTone === 'warning' ? 'text-warning-500' : 'text-accent-600'"
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

      <div
        v-if="bullets.length"
        class="flex flex-col gap-8 p-12 rounded-12 bg-surface-secondary"
      >
        <div
          v-for="(bullet, index) in bullets"
          :key="index"
          class="flex items-start gap-8"
        >
          <SvgIcon
            name="check-circle"
            class="!w-16 !h-16 text-accent-600 mt-2 shrink-0"
          />
          <p class="text-p3 text-content-secondary">
            {{ bullet }}
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
