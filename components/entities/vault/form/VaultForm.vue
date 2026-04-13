<script setup lang="ts">
defineProps<{ title?: string, description?: string, loading?: boolean, back?: boolean, backFallback?: string }>()
</script>

<template>
  <form
    v-bind="$attrs"
    class="flex flex-col mobile:min-h-[calc(100dvh-100px)] laptop:max-h-[calc(100dvh-88px)] laptop:overflow-clip laptop:px-16"
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
      class="flex flex-col gap-16 laptop:overflow-y-auto laptop:min-h-0 laptop:-mx-16 laptop:px-16 [&>*]:shrink-0"
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
