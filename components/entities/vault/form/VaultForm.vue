<script setup lang="ts">
defineProps<{ title?: string, loading?: boolean }>()
</script>

<template>
  <form
    v-bind="$attrs"
    class="flex flex-col gap-16"
  >
    <h1
      v-if="title"
      class="text-h2 text-content-primary pb-4"
    >
      {{ title }}
    </h1>

    <div
      v-if="loading"
      class="justify-center items-center"
      style="flex: 1"
    >
      <UiLoader />
    </div>

    <slot v-else />

    <div
      class="flex flex-col gap-8 mobile:mt-auto"
    >
      <slot name="buttons" />
    </div>
  </form>
</template>
