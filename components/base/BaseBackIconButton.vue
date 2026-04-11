<script setup lang="ts">
const props = withDefaults(defineProps<{ fallback?: string, exact?: boolean }>(), { fallback: '/portfolio', exact: false })
const router = useRouter()

function goBack() {
  if (!props.exact && window.history.state?.back) {
    router.back()
  }
  else {
    navigateTo(props.fallback)
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
