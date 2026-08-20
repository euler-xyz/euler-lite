<script setup lang="ts">
const { attempts, error, reconcile } = useReviewedExecutionRecovery()
const workingAttemptId = ref<string>()

const recover = async (attemptId: string) => {
  workingAttemptId.value = attemptId
  try {
    await reconcile(attemptId)
  }
  finally {
    workingAttemptId.value = undefined
  }
}
</script>

<template>
  <aside
    v-if="attempts.length || error"
    aria-live="polite"
    class="fixed bottom-24 right-16 z-[102] w-[360px] max-w-[calc(100vw-32px)] rounded-xl border border-warning-500 bg-background p-16 shadow-lg"
  >
    <p class="text-sm font-semibold">
      Transaction recovery
    </p>
    <p
      v-if="error"
      class="mt-8 text-xs text-negative-500"
    >
      {{ error }}
    </p>
    <div
      v-for="attempt in attempts"
      :key="attempt.attemptId"
      class="mt-12"
    >
      <p class="text-xs">
        {{ attempt.state }} · chain {{ attempt.chainId }}
      </p>
      <UiButton
        class="mt-8"
        size="small"
        :loading="workingAttemptId === attempt.attemptId"
        @click="recover(attempt.attemptId)"
      >
        Check status
      </UiButton>
    </div>
  </aside>
</template>
