<script setup lang="ts">
const props = defineProps<{
  announcementUrl?: string
}>()
const emits = defineEmits(['close'])
</script>

<template>
  <BaseModalWrapper
    title="Batch transactions are now available"
    :close="false"
  >
    <div class="flex flex-col gap-16">
      <p class="text-content-secondary text-p3">
        Build a sequence of supported actions, review the combined wallet changes,
        and execute them together from one batch.
      </p>

      <ul class="flex flex-col gap-8 text-p3 text-content-secondary">
        <li class="flex items-start gap-8">
          <span class="text-accent-600 shrink-0">&#10003;</span>
          <span>Add supported deposits, borrows, withdrawals, repays, and earn actions</span>
        </li>
        <li class="flex items-start gap-8">
          <span class="text-accent-600 shrink-0">&#10003;</span>
          <span>Review the full operation list before submitting anything on-chain</span>
        </li>
        <li class="flex items-start gap-8">
          <span class="text-accent-600 shrink-0">&#10003;</span>
          <span>Simulations flag reverts, wallet shortfalls, and position health changes</span>
        </li>
      </ul>

      <p class="text-content-secondary text-p3">
        Batching is new, so check each step carefully before executing.
      </p>

      <a
        v-if="props.announcementUrl"
        :href="props.announcementUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="text-accent-600 text-p3 hover:underline"
      >
        Read the full announcement &rarr;
      </a>
    </div>

    <div class="flex justify-end mt-16">
      <UiButton
        size="xlarge"
        rounded
        variant="primary"
        @click="emits('close')"
      >
        Got it
      </UiButton>
    </div>
  </BaseModalWrapper>
</template>
