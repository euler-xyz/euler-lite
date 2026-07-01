<script setup lang="ts">
const props = defineProps<{ title?: string, description?: string, loading?: boolean, back?: boolean, backFallback?: string, backAlwaysFallback?: boolean, pageScroll?: boolean }>()

const formClasses = computed(() => [
  'flex flex-col mobile:min-h-[calc(100dvh-100px)] laptop:px-16',
  props.pageScroll
    ? 'vault-form--page-scroll'
    : 'laptop:max-h-[calc(100dvh-88px)] laptop:overflow-clip',
])

const contentClasses = computed(() => [
  'flex flex-col gap-16 laptop:-mx-16 laptop:px-16 [&>*]:shrink-0',
  props.pageScroll ? '' : 'laptop:overflow-y-auto laptop:min-h-0',
])
</script>

<template>
  <form
    v-bind="$attrs"
    :class="formClasses"
  >
    <div v-if="back || title || description">
      <div
        v-if="back || title"
        class="flex items-center gap-12 pb-4"
      >
        <BackButton
          v-if="back"
          class="tablet:hidden"
          :fallback="backFallback"
          :always-fallback="backAlwaysFallback"
        />
        <h1
          v-if="title"
          class="text-p1"
        >
          {{ title }}
        </h1>
      </div>
      <p
        v-if="description"
        class="text-p3 text-content-secondary pb-8"
      >
        {{ description }}
      </p>
    </div>

    <div
      v-if="loading"
      class="flex justify-center items-center"
      style="flex: 1"
    >
      <UiLoader />
    </div>

    <div
      v-else
      :class="contentClasses"
    >
      <slot />
    </div>

    <div
      v-if="!loading"
      class="flex flex-col gap-8 pt-16 laptop:-mx-16 laptop:px-16"
    >
      <slot name="buttons" />
    </div>
  </form>
</template>

<style scoped>
.vault-form--page-scroll {
  padding-bottom: 48px;
}

@media (max-width: 900px) {
  .vault-form--page-scroll {
    padding-bottom: max(64px, calc(env(safe-area-inset-bottom, 0px) + 48px));
  }
}
</style>
