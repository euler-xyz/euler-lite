<script setup lang="ts">
import { recoverableSubmissionLabel, usePendingSubmissionRecovery } from '~/composables/usePendingSubmissionRecovery'

/**
 * App-root banner for armed pending-submission records orphaned by a reload
 * before the wallet answered (direct forms, both migration pages, CoW
 * orders). They block every send for the wallet/chain and carry no id to
 * verify on-chain, so the only safe release is the user confirming the
 * wallet itself shows nothing pending. Mirrors the batch cart's release CTA,
 * which owns the 'batch' flow.
 */
const { entries, releaseError, release } = usePendingSubmissionRecovery()
</script>

<template>
  <div
    v-if="entries.length"
    class="pending-recovery"
    data-testid="pending-submission-recovery"
  >
    <p class="text-p3">
      A previous submission was handed to the wallet but no transaction id came
      back, so it cannot be verified automatically and blocks new transactions
      from this wallet. If your wallet's pending activity shows nothing
      pending, you can dismiss it.
    </p>
    <div
      v-for="entry in entries"
      :key="`${entry.flow}:${entry.chainId}:${entry.owner}`"
      class="pending-recovery-row"
    >
      <span class="text-p3 capitalize">
        Pending {{ recoverableSubmissionLabel(entry.flow) }} — chain {{ entry.chainId }}
      </span>
      <button
        type="button"
        class="pending-recovery-release"
        :data-testid="`release-armed-${entry.flow}`"
        @click="release(entry)"
      >
        My wallet shows nothing pending — dismiss it
      </button>
    </div>
    <p
      v-if="releaseError"
      class="text-p3 pending-recovery-error"
      data-testid="pending-submission-recovery-error"
    >
      {{ releaseError }}
    </p>
  </div>
</template>

<style scoped lang="scss">
.pending-recovery {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 16px;
  background-color: var(--bg-surface);
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-default);
  font-size: 14px;
  line-height: 20px;
}

.pending-recovery-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.pending-recovery-release {
  text-decoration: underline;
  cursor: pointer;
  white-space: nowrap;

  &:hover {
    color: var(--text-secondary);
  }
}

.pending-recovery-error {
  color: var(--error-300);
}
</style>
