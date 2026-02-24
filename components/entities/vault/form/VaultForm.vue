<script setup lang="ts">
defineProps<{ title?: string, loading?: boolean }>()
</script>

<template>
  <form
    v-bind="$attrs"
    class="flex flex-col mobile:min-h-[calc(100dvh-100px)] laptop:max-h-[calc(100dvh-88px)] laptop:overflow-clip laptop:px-16"
  >
    <h1
      v-if="title"
      class="text-p1 pb-4"
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

    <div
      v-else
      class="flex flex-col gap-16 laptop:overflow-y-auto laptop:min-h-0 laptop:-mx-16 laptop:px-16 [&>*]:shrink-0"
    >
      <slot />
    </div>

    <div
      class="flex flex-col gap-8 pt-16 mobile:mt-auto laptop:-mx-16 laptop:px-16"
    >
      <slot name="buttons" />
    </div>
  </form>
</template>
