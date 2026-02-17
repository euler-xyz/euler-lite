<script setup lang="ts">
const router = useRouter()

const handleClick = () => {
  router.back()
}
</script>

<template>
  <button
    class="max-w-[70px] inline-flex items-center gap-8 px-6 py-6 bg-transparent border-none rounded-[32px] text-p3 text-content-secondary font-semibold leading-20 cursor-pointer select-none transition-colors hover:bg-white/5 active:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
    type="button"
    @click="handleClick"
  >
    <SvgIcon
      class="!w-16 !h-16 rotate-90 flex-shrink-0"
      name="arrow-down"
    />
    <span class="leading-none">Back</span>
  </button>
</template>
