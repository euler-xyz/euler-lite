<script setup lang="ts">
const props = withDefaults(defineProps<{ fallback?: string, alwaysFallback?: boolean }>(), { fallback: '/portfolio', alwaysFallback: false })
const router = useRouter()

const safeFallback = computed(() => props.fallback.startsWith('/') ? props.fallback : '/portfolio')

function goBack() {
  if (!props.alwaysFallback && window.history.state?.back) {
    router.back()
  }
  else {
    navigateTo(safeFallback.value)
  }
}
</script>

<template>
  <button
    type="button"
    aria-label="Go back"
    class="inline-flex items-center justify-center px-8 py-6 rounded-8 border border-line-default bg-surface-elevated hover:bg-card-hover transition-colors text-content-secondary hover:text-content-primary flex-shrink-0"
    @click="goBack"
  >
    <UiIcon
      name="arrow-left"
      class="!w-16 !h-16"
    />
  </button>
</template>
