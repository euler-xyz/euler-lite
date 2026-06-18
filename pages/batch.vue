<script setup lang="ts">
// Full-page batch view (the small-screen counterpart of the laptop floating
// drawer), reached from the bottom-nav "Batch" item.
const { entryCount } = useTxBatch()
const router = useRouter()
const route = useRoute()

// Nothing to show once the batch is empty (cleared / executed) — return to the
// portfolio, preserving the active network.
watch(entryCount, (count) => {
  if (count === 0) router.replace({ path: '/portfolio', query: { network: route.query.network } })
}, { immediate: true })
</script>

<template>
  <div class="max-w-container mx-auto w-full px-16 pb-[112px]">
    <div class="flex items-center gap-8 py-16">
      <span class="inline-flex items-center justify-center w-24 h-24 rounded-full bg-accent-600 text-content-inverse text-p3 font-semibold">
        {{ entryCount }}
      </span>
      <h1 class="text-h3 text-content-primary">
        Transaction batch
      </h1>
    </div>
    <div class="rounded-16 border border-line-default bg-card shadow-card overflow-hidden">
      <BatchContents />
    </div>
  </div>
</template>
