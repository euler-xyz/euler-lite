<script setup lang="ts">
import { computed } from 'vue'
import { BatchReviewModal, OperationReviewModal } from '#components'
import { useTxBatch, type BatchEntry } from '~/composables/useTxBatch'
import { useModal } from '~/components/ui/composables/useModal'

// Shared batch body, used by the laptop floating drawer (BatchDrawer) and the
// mobile full-page view (pages/batch.vue). The operation circle + label come
// from the shared BatchStepCircle / BatchOperationLabel components (also used by
// the review modal); the market lives in the per-op review modal opened on click.
const {
  entries,
  layers,
  isSimulated,
  isSimulating,
  simError,
  execError,
  insufficientBalanceMessage,
  walletChanges,
  removeEntry,
  clearBatch,
  setActiveLayer,
  entryPlans,
} = useTxBatch()

const modal = useModal()

// Per-row quick peek at the operation's own review (the contextual batch-layer
// plan, no execute). The full batch review is the "Review batch" button below.
const openEntryReview = (entry: BatchEntry) => {
  if (!entry.review) return
  modal.open(OperationReviewModal, {
    // Forward the entry's sub-account so the review shows the same "Position N"
    // pill as the batch operations list (entry.review itself doesn't carry it).
    props: { ...entry.review, subAccount: entry.subAccount, plan: entryPlans.value[entry.id], hideExecute: true },
  })
}

const openBatchReview = () => {
  if (!entries.value.length) return
  modal.open(BatchReviewModal)
}

// Eye toggle: peek at the real state (layer 0) vs the simulated end state
// (last layer). The simulated layers stay computed either way.
const toggleSimulationView = () => {
  setActiveLayer(isSimulated.value ? 0 : layers.value.length - 1)
}
const simEyeLabel = computed(() =>
  isSimulated.value ? 'Showing simulated state' : 'Showing real state',
)
</script>

<template>
  <div>
    <!-- Entries — a connected stepper: each operation is a numbered node on a
         vertical rail, so the batch reads as an ordered, atomic sequence. -->
    <ul class="max-h-[280px] overflow-auto px-16 pt-12 pb-4">
      <li
        v-for="(entry, index) in entries"
        :key="entry.id"
        class="relative flex flex-col pb-14"
      >
        <!-- Connector rail: runs from this circle's centre down to the next,
             behind the opaque circles, so 2+ operations read as a connected
             stepper. h-full reaches the next circle's centre (= li height + the
             14px top offset). -->
        <span
          v-if="entries.length >= 2 && index < entries.length - 1"
          aria-hidden="true"
          class="absolute left-[11px] top-[14px] h-full w-[1.5px] -translate-x-1/2 bg-line-default"
        />

        <!-- First line: status circle + clickable description + remove -->
        <div class="flex items-center gap-12">
          <BatchStepCircle
            :index="index + 1"
            :failed="!!layers[index + 1]?.failed"
            class="relative z-[1]"
          />
          <!-- The whole description is the clickable affordance to open this
               operation's review (replaces the separate (i) icon). -->
          <button
            v-if="entry.review"
            type="button"
            class="flex items-center gap-8 min-w-0 flex-1 text-left rounded-8 hover:opacity-80 transition-opacity"
            title="Review operation details"
            :data-testid="`batch-details-${index}`"
            @click="openEntryReview(entry)"
          >
            <BatchOperationLabel :entry="entry" />
          </button>
          <span
            v-else
            class="min-w-0 flex-1 truncate text-p2 text-content-primary"
          >{{ entry.label }}</span>
          <button
            type="button"
            class="flex items-center justify-center w-28 h-28 rounded-8 text-content-tertiary hover:text-error-500 hover:bg-card-hover shrink-0"
            title="Remove from batch"
            :data-testid="`batch-remove-${index}`"
            @click="removeEntry(entry.id)"
          >
            <SvgIcon
              name="close"
              class="!w-16 !h-16"
            />
          </button>
        </div>

        <!-- Persistent (not hover-only) revert reason, aligned under the label -->
        <BatchAlert
          v-if="layers[index + 1]?.failed"
          compact
          class="ml-[34px] mt-6"
          :message="layers[index + 1]?.error || 'This operation would revert.'"
        />
      </li>
    </ul>

    <!-- Wallet changes — the whole batch's net effect on the wallet, shown in
         both the simulated and real views. -->
    <BatchWalletChanges
      v-if="walletChanges.length"
      :changes="walletChanges"
      class="mx-16 mb-4"
      data-testid="batch-wallet-changes"
    />

    <!-- Top-level batch errors (revert / status-check / wallet shortfall). The
         batch simulates fine (balances are forged) but can't execute — same
         pattern as a failed health check. -->
    <BatchAlert
      v-if="simError || execError || insufficientBalanceMessage"
      class="mx-16 mb-4"
      :message="execError || simError || insufficientBalanceMessage"
    />

    <!-- Footer -->
    <div class="px-16 pt-8 pb-14">
      <!-- Secondary actions — kept away from the primary CTA -->
      <div class="flex items-center justify-between mb-10">
        <button
          type="button"
          class="flex items-center gap-6 text-p3 text-content-tertiary hover:text-content-primary"
          data-testid="batch-toggle-sim"
          @click="toggleSimulationView"
        >
          <SvgIcon
            :name="isSimulated ? 'eye' : 'eye-off'"
            class="!w-16 !h-16"
          />
          {{ simEyeLabel }}
        </button>
        <button
          type="button"
          class="flex items-center gap-6 text-p3 text-content-tertiary hover:text-error-500"
          data-testid="batch-clear"
          @click="clearBatch"
        >
          <SvgIcon
            name="trash"
            class="!w-16 !h-16"
          />
          Clear batch
        </button>
      </div>

      <!-- Primary action: open the batch review (approvals + details + execute) -->
      <button
        type="button"
        class="w-full h-40 rounded-12 bg-accent-600 hover:bg-accent-700 text-black text-p2 font-semibold shadow-accent-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
        :disabled="!entries.length || isSimulating"
        data-testid="batch-review"
        @click="openBatchReview"
      >
        {{ isSimulating ? 'Simulating…' : 'Review batch' }}
      </button>
    </div>
  </div>
</template>
