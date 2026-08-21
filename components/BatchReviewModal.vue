<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { getAddress } from 'viem'
import { flattenBatchEntries, getSubAccountId, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { buildModifiedPositionKeySets, buildRemovedPositionKeySets, filterPositionKeysByOwner, useTxBatch } from '~/composables/useTxBatch'
import { useTokenSymbolResolver } from '~/composables/useTokenSymbolResolver'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { getAssetLogoUrl } from '~/composables/useTokenList'
import { buildTransactionPlanDisplaySteps, type DisplayStep, type StepDecodingContext } from '~/utils/stepDecoding'
import { logWarn } from '~/utils/errorHandling'
import { buildBatchHealthSummary } from '~/utils/batchHealthSummary'
import { consolidateRestorationSummaryRows, getAuthorizationStepDisplay, groupRestorationSummaryRows } from '~/utils/batchReviewDisplay'
import { hasPermit2TokenApproval } from '~/utils/transactionPlanApprovals'
import { isPlanBundleable } from '~/utils/transaction-plan-calls'
import type { TrackedExecutionHandle } from '~/composables/useSafeExecutionDetachment'
import { formatNumber } from '~/utils/string-utils'
import type { PreparedExecutionReview } from '~/composables/useReviewedExecution'
import { submissionResultMessage } from '~/features/reviewed-execution/coordinator/coordinator'
import { useToast } from '~/components/ui/composables/useToast'

// Whole-batch review: required approvals, then the operations as rows that roll
// down to their details, the net wallet changes, a Tenderly simulation link,
// and one atomic Execute. Opened from the "Review batch" button in the drawer
// (and mobile page). The per-operation detail is the data captured at add-time;
// execution is authorized only by the reviewed whole-cart execution.
const emit = defineEmits(['close'])

const {
  entries,
  layers,
  walletChanges,
  simError,
  execError,
  isSimulating,
  canExecuteBatch,
  hasFailedOps,
  hasInsufficientBalance,
  insufficientBalanceMessage,
  prepareBatchExecutionReview,
  removeIntentRevisions,
  setExecutionError,
  entryPlans,
  marketByEntryId,
  tenderlyEnabled,
  isTenderlySimulating,
  tenderlyUrl,
  tenderlyError,
  fetchTenderlyEnabled,
  simulateOnTenderly: simulateBatchOnTenderly,
  dismissExecutionError,
} = useTxBatch()
const executionService = useReviewedExecution()
const toast = useToast()
const isExecuting = ref(false)
const preparedExecution = shallowRef<PreparedExecutionReview | null>(null)

const { isSpyMode, effectiveAddress } = useEffectiveAddress()
const { eulerCoreAddresses } = useEulerAddresses()
const { buildKnownSymbols, resolveSymbol } = useTokenSymbolResolver()
const { getVault, isVerifiedVault } = useVaultRegistry()
const { copied, copyToClipboard } = useClipboardCopy()
const owner = computed(() => effectiveAddress.value || '')
const ownerSubAccountKey = computed(() => {
  try {
    return owner.value ? getAddress(owner.value).toLowerCase() : undefined
  }
  catch {
    return undefined
  }
})

// Sub-account → tag. Sub-account 0 is the main account (Earn deposits / base
// collateral), labelled "Deposits"; numbered borrow positions are "Position N".
const positionTag = (subAccount?: string): string | undefined => {
  if (!subAccount || !owner.value) return undefined
  try {
    const idx = getSubAccountId(getAddress(owner.value), getAddress(subAccount))
    return idx === 0 ? 'Deposits' : `Position ${idx}`
  }
  catch {
    return undefined
  }
}

type ReviewWithSteps = StepDecodingContext & {
  displayPlan?: TransactionPlan
  signatureSteps?: DisplayStep[]
  postSteps?: DisplayStep[]
}

const isExternalProtocolMigrationReview = (review: ReviewWithSteps | undefined): boolean =>
  review?.type === 'migration'

const normalizeDisplaySteps = (steps: DisplayStep[] | undefined): DisplayStep[] =>
  (steps ?? []).map((step, idx) => ({ ...step, index: idx + 1 }))

// Bundled styling follows the wallet transport sealed for this review. Live
// wallet state cannot change the displayed or submitted execution.
const isBundledEntry = (entry: typeof entries.value[number]): boolean =>
  preparedExecution.value?.execution.requestSet.transport === 'safe'
  && isExternalProtocolMigrationReview(entry.review as unknown as ReviewWithSteps | undefined)

const overrideBundled = (steps: DisplayStep[], entry: typeof entries.value[number]): DisplayStep[] =>
  isBundledEntry(entry)
    ? steps.map(step => ({ ...step, isSeparateTx: false }))
    : steps

const getEntrySignatureSteps = (entry: typeof entries.value[number]): DisplayStep[] => {
  const review = entry.review as unknown as ReviewWithSteps | undefined
  return isExternalProtocolMigrationReview(review)
    ? overrideBundled(normalizeDisplaySteps(review?.signatureSteps), entry)
    : []
}

const getEntryPostSteps = (entry: typeof entries.value[number]): DisplayStep[] => {
  const review = entry.review as unknown as ReviewWithSteps | undefined
  return isExternalProtocolMigrationReview(review)
    ? overrideBundled(normalizeDisplaySteps(review?.postSteps), entry)
    : []
}

// Per-operation step list — the exact decoded steps the per-op review modal
// (opened by the row's (i) icon in the builder) shows, built from that op's
// contextual plan (entryPlans) and the review context captured at add-time.
// This is what an expanded row reveals.
const stepsByEntryId = computed<Record<string, DisplayStep[]>>(() => {
  const out: Record<string, DisplayStep[]> = {}
  for (const entry of entries.value) {
    const plan = (entry.review as unknown as ReviewWithSteps | undefined)?.displayPlan ?? entryPlans.value[entry.id]
    const ctx = entry.review as unknown as StepDecodingContext | undefined
    if (!plan?.length || !ctx) continue
    try {
      out[entry.id] = buildTransactionPlanDisplaySteps(plan, { ...ctx, bundledApprovals: bundlesApprovals.value }, getVault, getAssetLogoUrl)
    }
    catch (error) {
      logWarn('BatchReviewModal/steps', error)
    }
  }
  return out
})

const signatureStepsByEntryId = computed<Record<string, DisplayStep[]>>(() => {
  const out: Record<string, DisplayStep[]> = {}
  for (const entry of entries.value) {
    const steps = getEntrySignatureSteps(entry)
    if (steps.length) out[entry.id] = steps
  }
  return out
})

const postStepsByEntryId = computed<Record<string, DisplayStep[]>>(() => {
  const out: Record<string, DisplayStep[]> = {}
  for (const entry of entries.value) {
    const steps = getEntryPostSteps(entry)
    if (steps.length) out[entry.id] = steps
  }
  return out
})

const signatureStepsHeading = (entryId: string): string => {
  const entry = entries.value.find(candidate => candidate.id === entryId)
  if (entry && isBundledEntry(entry)) return 'Authorization transactions'
  return getAuthorizationStepDisplay(
    (signatureStepsByEntryId.value[entryId] ?? []).some(step => step.isSeparateTx),
  ).detailHeading
}

const restorationStepsHeading = (entry: typeof entries.value[number]): string =>
  isBundledEntry(entry) ? 'Authorization restorations' : 'After execution'

const authorizationRows = computed(() =>
  entries.value.flatMap(entry =>
    (signatureStepsByEntryId.value[entry.id] ?? []).map(step => ({ entry, step, bundledTx: isBundledEntry(entry) })),
  ),
)
// Three reviewed executions, three groups: standalone transactions, transactions
// riding in the Safe proposal, and wallet signatures.
const authorizationSummaryGroups = computed(() => {
  const rows = authorizationRows.value
  const groups: Array<{ rows: typeof rows, display: { summaryHeading: string, itemCountLabel: string } }> = []
  const separate = rows.filter(({ step }) => step.isSeparateTx)
  if (separate.length) groups.push({ rows: separate, display: getAuthorizationStepDisplay(true) })
  const bundled = rows.filter(({ step, bundledTx }) => !step.isSeparateTx && bundledTx)
  if (bundled.length) {
    groups.push({ rows: bundled, display: { summaryHeading: 'Authorization transactions', itemCountLabel: 'bundled in proposal' } })
  }
  const signatures = rows.filter(({ step, bundledTx }) => !step.isSeparateTx && !bundledTx)
  if (signatures.length) groups.push({ rows: signatures, display: getAuthorizationStepDisplay(false) })
  return groups
})

// Authorization restorations run after the operation. They either ride at the
// tail of the same Safe proposal or are sent as standalone post-execution
// transactions; the collapsed summary keeps those reviewed executions distinct.
//
// Rows render in EXECUTION order: restorations unwind in reverse entry order
// (each entry's own steps are already reversed by the encoder). Identical
// standalone restorations are consolidated because sequential prerequisite
// resolution sends them once. Bundled Safe restorations are already collected
// proposal calls, so every call remains visible. Labels are NOT identity: two
// different aTokens can share a label while representing distinct transactions.
const restorationSummaryRows = computed(() => {
  const rows = [...entries.value].reverse().flatMap(entry =>
    (postStepsByEntryId.value[entry.id] ?? []).map(step => ({ entry, step })),
  )
  return consolidateRestorationSummaryRows(rows)
})

const restorationSummaryGroups = computed(() => {
  const rows = groupRestorationSummaryRows(restorationSummaryRows.value)
  return [
    ...(rows.bundled.length
      ? [{ key: 'bundled', heading: 'Authorization restorations', itemCountLabel: 'bundled in proposal', rows: rows.bundled }]
      : []),
    ...(rows.postExecution.length
      ? [{ key: 'post-execution', heading: 'After execution', itemCountLabel: '1 transaction', rows: rows.postExecution }]
      : []),
  ]
})

// Unverified vaults the batch touches — surfaced as a warning. A vault is the
// target of an op's core action; we read targets off each op's contextual plan
// and check the registry's verification flag (same source the forms use).
const unverifiedVaultNames = computed<string[]>(() => {
  const names = new Set<string>()
  for (const entry of entries.value) {
    const plan = entryPlans.value[entry.id]
    if (!plan) continue
    for (const item of plan) {
      if (item.type !== 'evcBatch') continue
      for (const bi of flattenBatchEntries(item.items)) {
        try {
          const addr = getAddress(bi.targetContract)
          const vault = getVault(addr) as { shares?: { name?: string }, asset?: { symbol?: string } } | undefined
          if (vault && !isVerifiedVault(addr)) {
            const name = vault.shares?.name || vault.asset?.symbol || ''
            if (name) names.add(name)
          }
        }
        catch { /* skip malformed address */ }
      }
    }
  }
  return [...names]
})
const hasUnverified = computed(() => unverifiedVaultNames.value.length > 0)

interface REULUnlockInfo {
  unlockableAmount: number
  amountToBeBurned: number
  maturityDate: string
  daysUntilMaturity: number
}

const isREULUnlockInfo = (value: unknown): value is REULUnlockInfo => {
  if (!value || typeof value !== 'object') return false
  const info = value as Partial<REULUnlockInfo>
  return typeof info.unlockableAmount === 'number'
    && typeof info.amountToBeBurned === 'number'
    && typeof info.maturityDate === 'string'
    && typeof info.daysUntilMaturity === 'number'
}

const reulUnlockWarnings = computed<Array<{ id: string, description: string }>>(() =>
  entries.value.flatMap((entry) => {
    const review = entry.review as { type?: string, reulUnlockInfo?: unknown } | undefined
    if (review?.type !== 'reul-unlock' || !isREULUnlockInfo(review.reulUnlockInfo)) return []
    const info = review.reulUnlockInfo
    return [{
      id: entry.id,
      description: `This batch includes an rEUL unlock that will unlock ${formatNumber(info.unlockableAmount, 6)} EUL, and ${formatNumber(info.amountToBeBurned, 6)} EUL will be permanently burned. To fully redeem your EUL rewards, wait for the 6-month vesting period to complete (${info.daysUntilMaturity} days remaining, maturity date: ${info.maturityDate}).`,
    }]
  }),
)

// Sub-accounts of entries that revert mid-batch (per-item revert: vault
// liquidity, vault cap, etc.). The op rolls back so its position SHOULD be
// unchanged, but in some cases the layer's reported health factor still drifts
// slightly from the base — so the unchanged-health equality below is unreliable
// for these. Drop them explicitly to keep the summary consistent.
// NOTE: deferred *account* status checks (e.g. a withdraw leaving the account
// unhealthy) deliberately stay in the summary — the simulated post-state is the
// useful signal even though the batch is blocked.
const revertedSubAccounts = computed<Set<string>>(() => {
  const set = new Set<string>()
  entries.value.forEach((entry, i) => {
    if (!layers.value[i + 1]?.failed || !entry.subAccount) return
    try {
      set.add(getAddress(entry.subAccount).toLowerCase())
    }
    catch {
      /* skip malformed address */
    }
  })
  return set
})

const scopedEntrySubAccounts = computed<Set<string> | undefined>(() => {
  const set = new Set<string>()
  for (const entry of entries.value) {
    if (!entry.subAccount) return undefined
    try {
      set.add(getAddress(entry.subAccount).toLowerCase())
    }
    catch {
      return undefined
    }
  }
  return set
})

const changedPositionKeys = computed<Set<string>>(() => {
  const base = layers.value[0]?.account
  const final = layers.value[layers.value.length - 1]?.account
  const keys = new Set(buildModifiedPositionKeySets(final, base).any)
  for (const key of buildRemovedPositionKeySets(final, base)) keys.add(key)
  return filterPositionKeysByOwner(keys, ownerSubAccountKey.value, scopedEntrySubAccounts.value)
})

// Resulting health per position the batch changes: compare each borrow
// position's health factor on the real (layer 0) vs the final simulated layer,
// and list those that move (with their Position tag and before → after score).
const healthSummary = computed<Array<{ label: string, before?: string, after: string }>>(() => {
  if (layers.value.length < 2) return []
  return buildBatchHealthSummary({
    basePortfolio: layers.value[0]?.portfolio,
    finalPortfolio: layers.value[layers.value.length - 1]?.portfolio,
    changedPositionKeys: changedPositionKeys.value,
    revertedSubAccounts: revertedSubAccounts.value,
    positionTag,
  })
})

// Roll-down: rows are collapsed by default; one row open at a time.
const openId = ref<string | null>(null)
const toggle = (id: string) => {
  openId.value = openId.value === id ? null : id
}
const nowMs = ref(Date.now())
const staleQuoteThresholdMs = 3 * 60 * 1000
let nowTimer: ReturnType<typeof setInterval> | undefined

const getQuoteFetchedAt = (entry: { review?: Record<string, unknown> }): number | null => {
  const value = entry.review?.quoteFetchedAt
  return typeof value === 'number' ? value : null
}
const isEntryQuoteStale = (entry: { review?: Record<string, unknown> }) => {
  const fetchedAt = getQuoteFetchedAt(entry)
  return typeof fetchedAt === 'number' && nowMs.value - fetchedAt > staleQuoteThresholdMs
}
const hasStaleQuoteEntries = computed(() => entries.value.some(isEntryQuoteStale))

// Approvals the user will be asked to sign, decoded from the prepared plan.
interface ResolvedApproval { type: string, token: string }
const approvals = ref<Array<{ kind: 'approve' | 'permit', symbol: string }>>([])
const isPreparing = ref(false)
const prepareError = ref('')
// The prepared plan (with approvals resolved) backs "Copy calldata".
const preparedPlanRef = ref<TransactionPlan | undefined>()
const hasPermit2Approval = computed(() =>
  hasPermit2TokenApproval(preparedPlanRef.value, eulerCoreAddresses.value?.permit2),
)
// Mirrors execution eligibility: only claim bundling when the merged plan
// would actually submit as one Safe bundle.
const bundlesApprovals = computed(() =>
  preparedExecution.value?.execution.requestSet.wallet.walletKind === 'safe'
  && !!preparedPlanRef.value
  && isPlanBundleable(preparedPlanRef.value),
)

onMounted(async () => {
  nowTimer = setInterval(() => {
    nowMs.value = Date.now()
  }, 1000)
  void fetchTenderlyEnabled()
  isPreparing.value = true
  prepareError.value = ''
  try {
    const prepared = await prepareBatchExecutionReview()
    preparedExecution.value = prepared
    preparedPlanRef.value = prepared.previewPlan
    const known = buildKnownSymbols()
    const out: Array<{ kind: 'approve' | 'permit', symbol: string }> = []
    for (const item of prepared.previewPlan) {
      if ((item as { type?: string }).type !== 'requiredApproval') continue
      const resolved = (item as { resolved?: ResolvedApproval[] }).resolved ?? []
      for (const r of resolved) {
        out.push({ kind: r.type === 'approve' ? 'approve' : 'permit', symbol: resolveSymbol(r.token, known) })
      }
    }
    approvals.value = out
  }
  catch (error) {
    logWarn('BatchReviewModal/prepare', error)
    prepareError.value = 'Unable to prepare this batch. Resolve the preparation error before copying calldata or executing.'
  }
  finally {
    isPreparing.value = false
  }
})

onUnmounted(() => {
  if (nowTimer) {
    clearInterval(nowTimer)
  }
})

// Copy the exact batch calldata (one entry per on-chain tx: approvals + the EVC
// batch), matching the per-operation review modals. This requires the prepared
// plan so approval txs are included.
const isCalldataCopyDisabled = computed(() =>
  isPreparing.value || !!prepareError.value || !preparedPlanRef.value?.length,
)
const copyCalldata = async () => {
  const prepared = preparedExecution.value
  if (!prepared) return
  try {
    const out = prepared.execution.requestSet.requests.map(request => ({
      to: request.to,
      data: request.data,
      value: request.value.toString(),
    }))
    copyToClipboard(JSON.stringify(out, null, 2), 'calldata')
  }
  catch (error) {
    logWarn('BatchReviewModal/copyCalldata', error)
  }
}

const hasTenderlyFailed = computed(() => Boolean(tenderlyUrl.value && tenderlyError.value))
const simulateOnTenderly = () => simulateBatchOnTenderly(preparedExecution.value ?? undefined)

const isConfirmDisabled = computed(() =>
  isSpyMode.value || isExecuting.value || hasPendingDetachedExecution.value || isPreparing.value || isSimulating.value || !canExecuteBatch.value || !!prepareError.value,
)
const blockedReason = computed(() => {
  if (isSpyMode.value) return 'Connect a wallet to execute — disabled in spy mode'
  if (hasFailedOps.value) return 'Resolve the reverting operation to execute'
  if (hasInsufficientBalance.value) return insufficientBalanceMessage.value || 'Not enough balance to execute this batch'
  if (simError.value) return 'This batch would revert — resolve the flagged error'
  return ''
})

const { beginTrackedExecution, hasPendingDetachedExecution } = useSafeExecutionDetachment()

let pendingBatchExecution: Promise<void> | null = null
let executionHandle: TrackedExecutionHandle | null = null

const handleExecute = async () => {
  if (isConfirmDisabled.value) return
  const prepared = preparedExecution.value
  if (!prepared) return
  // Latch the wallet classification at submission time; the single-slot gate
  // rejects new submissions while a detached proposal is pending.
  const handle = beginTrackedExecution({ safeAtSubmit: prepared.execution.requestSet.wallet.walletKind === 'safe' })
  if (!handle) return
  const capturedRevisions = prepared.execution.binding.intentRevisions
  isExecuting.value = true
  setExecutionError(undefined)
  const run = (async () => {
    try {
      const result = await executionService.accept(prepared.execution.reviewId, prepared.execution.reviewDigest)
      if (result.status !== 'submitted') throw new Error(submissionResultMessage(result))
      handle.scope.markSucceeded()
      if (!handle.scope.suppressPostTxUi()) {
        if (result.migration) {
          const revocation = result.migration.revocation
          const description = revocation
            ? `Authorization revocation status: ${revocation.status}.`
            : 'No separate authorization revocation request was required.'
          if (result.migration.warning) toast.warning('Migration submitted', { description: `${description} ${result.migration.warning}` })
          else toast.success('Migration submitted', { description })
        }
        removeIntentRevisions(capturedRevisions)
      }
    }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Batch execution failed'
      setExecutionError(message)
      throw cause
    }
    finally {
      isExecuting.value = false
    }
  })()
  pendingBatchExecution = run
  executionHandle = handle
  try {
    await run.catch(() => {})
  }
  finally {
    pendingBatchExecution = null
    executionHandle?.release()
    executionHandle = null
  }
  // A successful execution removes only its captured intent revisions.
  if (!execError.value && entries.value.length === 0) emit('close')
}

const handleClose = () => {
  if (!isExecuting.value && preparedExecution.value) {
    executionService.discard(preparedExecution.value.execution.reviewId)
  }
  dismissExecutionError()
  emit('close')
}

// Safe proposals can wait on co-signers for minutes to days — allow closing
// the modal mid-execution and surface completion as a toast instead. Uses the
// classification latched at submit, not live detection.
const canDetachExecution = computed(() =>
  isExecuting.value && executionHandle?.safeAtSubmit === true)

const onCloseRequested = () => {
  if (isExecuting.value) {
    if (!canDetachExecution.value) return
    if (pendingBatchExecution && executionHandle) {
      // executeBatch resolves on failure too (it reports via execError), so
      // surface that state as the detached completion outcome.
      executionHandle.detach(pendingBatchExecution.then(() => {
        if (execError.value) throw new Error(execError.value)
      }), { successMessage: 'Batch confirmed' })
      executionHandle = null
    }
  }
  handleClose()
}
</script>

<template>
  <BaseModalWrapper
    title="Review batch"
    @close="onCloseRequested"
  >
    <!-- Separator under the modal title -->
    <div class="-mx-16 mb-16 border-t border-line-default" />
    <div class="flex flex-col gap-20">
      <!-- Wallet authorizations captured by operations such as migrations. -->
      <template
        v-for="group in authorizationSummaryGroups"
        :key="group.display.summaryHeading"
      >
        <div>
          <p class="text-p3 text-content-tertiary uppercase tracking-[0.04em] mb-8">
            {{ group.display.summaryHeading }}
          </p>
          <div class="bg-surface-secondary rounded-12 px-12 divide-y divide-line-default">
            <div
              v-for="({ entry, step }, i) in group.rows"
              :key="`${entry.id}-${i}`"
              class="flex items-center justify-between gap-12 py-10"
            >
              <span class="flex items-center gap-8 text-p3 text-content-secondary min-w-0">
                <SvgIcon
                  name="check-circle"
                  class="!w-16 !h-16 text-accent-500 shrink-0"
                />
                <span class="truncate">{{ step.label }}</span>
              </span>
              <span class="text-p3 text-content-tertiary shrink-0">{{ group.display.itemCountLabel }}</span>
            </div>
          </div>
        </div>
      </template>

      <!-- Approvals -->
      <div v-if="approvals.length">
        <p class="text-p3 text-content-tertiary uppercase tracking-[0.04em] mb-8">
          Approvals needed
        </p>
        <div class="bg-surface-secondary rounded-12 px-12 divide-y divide-line-default">
          <div
            v-for="(a, i) in approvals"
            :key="i"
            class="flex items-center justify-between py-10"
          >
            <span class="flex items-center gap-8 text-p3 text-content-secondary">
              <SvgIcon
                :name="a.kind === 'permit' ? 'check-circle' : 'info-circle'"
                class="!w-16 !h-16"
                :class="a.kind === 'permit' ? 'text-accent-500' : 'text-content-tertiary'"
              />
              {{ a.kind === 'permit' ? `Sign permit2 — ${a.symbol}` : `Approve ${a.symbol}` }}
            </span>
            <span class="text-p3 text-content-tertiary">{{ a.kind === 'permit' ? '1 signature' : bundlesApprovals ? 'bundled in batch' : '1 transaction' }}</span>
          </div>
        </div>
      </div>

      <UiAlert
        v-if="hasPermit2Approval"
        variant="info"
        size="compact"
        title="Infinite approval"
        description="You are granting the Permit2 contract an unlimited token allowance. Permit2 is a Uniswap contract that lets you approve once, then sign per-action permissions without new onchain approvals."
      />

      <UiAlert
        v-if="hasStaleQuoteEntries"
        variant="warning"
        size="compact"
        title="Stale swap quote"
        description="This batch includes a swap quote which is more than 3 minutes old. Consider refreshing it to get the best execution price"
      />

      <!-- Operations -->
      <div>
        <p class="text-p3 text-content-tertiary uppercase tracking-[0.04em] mb-8">
          Operations
        </p>
        <div class="flex flex-col gap-8">
          <div
            v-for="(entry, index) in entries"
            :key="entry.id"
            class="rounded-8 border bg-surface-secondary overflow-hidden transition-colors"
            :class="openId === entry.id ? 'border-accent-600' : 'border-line-default'"
          >
            <button
              type="button"
              class="flex items-center justify-between gap-8 w-full px-12 py-11 text-left"
              :data-testid="`batch-review-row-${index}`"
              :aria-expanded="openId === entry.id"
              :aria-controls="`batch-review-detail-${index}`"
              @click="toggle(entry.id)"
            >
              <span class="flex items-center gap-8 min-w-0">
                <BatchStepCircle
                  :index="index + 1"
                  :failed="!!layers[index + 1]?.failed"
                />
                <BatchOperationLabel :entry="entry" />
                <span
                  v-if="positionTag(entry.subAccount)"
                  class="shrink-0 text-h6 text-content-secondary bg-card py-2 px-8 rounded-8 border border-line-default"
                >
                  {{ positionTag(entry.subAccount) }}
                </span>
              </span>
              <SvgIcon
                name="arrow-down"
                class="!w-16 !h-16 text-content-tertiary transition-transform shrink-0"
                :class="{ 'rotate-180': openId === entry.id }"
              />
            </button>

            <div
              v-if="openId === entry.id"
              :id="`batch-review-detail-${index}`"
              class="px-12 pb-12 pt-2 border-t border-line-default"
            >
              <BatchMarketLabel
                :market="marketByEntryId[entry.id]"
                class="mt-6 px-12"
              />
              <UiAlert
                v-if="isEntryQuoteStale(entry)"
                class="mt-6"
                variant="warning"
                size="compact"
                title="Stale swap quote"
                description="This operation uses a swap quote that is more than 3 minutes old."
              />
              <!-- Same decoded operation steps the per-op review modal shows
                   (the builder row's (i) icon). -->
              <div
                v-if="signatureStepsByEntryId[entry.id]?.length || stepsByEntryId[entry.id]?.length || postStepsByEntryId[entry.id]?.length"
                class="bg-card rounded-8 p-12 flex flex-col gap-8"
              >
                <template v-if="signatureStepsByEntryId[entry.id]?.length">
                  <p class="text-p4 text-content-tertiary uppercase tracking-[0.04em]">
                    {{ signatureStepsHeading(entry.id) }}
                  </p>
                  <OperationStepsList :steps="signatureStepsByEntryId[entry.id]" />
                  <div
                    v-if="stepsByEntryId[entry.id]?.length"
                    class="border-t border-line-default"
                  />
                </template>
                <template v-if="stepsByEntryId[entry.id]?.length">
                  <p
                    v-if="signatureStepsByEntryId[entry.id]?.length"
                    class="text-p4 text-content-tertiary uppercase tracking-[0.04em]"
                  >
                    Operation
                  </p>
                  <OperationStepsList :steps="stepsByEntryId[entry.id]" />
                </template>
                <template v-if="postStepsByEntryId[entry.id]?.length">
                  <div
                    v-if="signatureStepsByEntryId[entry.id]?.length || stepsByEntryId[entry.id]?.length"
                    class="border-t border-line-default"
                  />
                  <p class="text-p4 text-content-tertiary uppercase tracking-[0.04em]">
                    {{ restorationStepsHeading(entry) }}
                  </p>
                  <OperationStepsList :steps="postStepsByEntryId[entry.id]" />
                </template>
              </div>
              <p
                v-else
                class="py-4 text-p3 text-content-tertiary"
              >
                No operation details available.
              </p>
              <BatchAlert
                v-if="layers[index + 1]?.failed"
                compact
                class="mt-6"
                :message="layers[index + 1]?.error || 'This operation would revert.'"
              />
            </div>
          </div>
        </div>
      </div>

      <UiAlert
        v-for="warning in reulUnlockWarnings"
        :key="warning.id"
        variant="warning"
        size="compact"
        title="rEUL burn mechanics"
        :description="warning.description"
      />

      <!-- Authorization restorations, grouped by the reviewed execution that submits them. -->
      <template
        v-for="group in restorationSummaryGroups"
        :key="group.key"
      >
        <div>
          <p class="text-p3 text-content-tertiary uppercase tracking-[0.04em] mb-8">
            {{ group.heading }}
          </p>
          <div class="bg-surface-secondary rounded-12 px-12 divide-y divide-line-default">
            <div
              v-for="({ entry, step }, i) in group.rows"
              :key="`${entry.id}-${group.key}-${i}`"
              class="flex items-center justify-between gap-12 py-10"
            >
              <span class="flex items-center gap-8 text-p3 text-content-secondary min-w-0">
                <SvgIcon
                  name="check-circle"
                  class="!w-16 !h-16 text-accent-500 shrink-0"
                />
                <span class="truncate">{{ step.label }}</span>
              </span>
              <span class="text-p3 text-content-tertiary shrink-0">{{ group.itemCountLabel }}</span>
            </div>
          </div>
        </div>
      </template>

      <!-- Wallet changes -->
      <BatchWalletChanges
        v-if="walletChanges.length"
        :changes="walletChanges"
      />

      <!-- Health changes — resulting health score per position the batch moves -->
      <div
        v-if="healthSummary.length"
        class="bg-surface-elevated rounded-12 px-12 py-10"
      >
        <p class="text-p3 text-content-tertiary mb-6">
          Health changes
        </p>
        <ul class="flex flex-col gap-6">
          <li
            v-for="h in healthSummary"
            :key="h.label"
            class="flex items-center justify-between gap-8 text-p3"
          >
            <span class="shrink-0 text-h6 text-content-secondary bg-card py-2 px-8 rounded-8 border border-line-default">
              {{ h.label }}
            </span>
            <span class="tabular-nums text-content-primary">
              <span
                v-if="h.before"
                class="text-content-tertiary"
              >{{ h.before }} → </span>{{ h.after }}
            </span>
          </li>
        </ul>
      </div>

      <!-- Unverified vault warning -->
      <UiAlert
        v-if="hasUnverified"
        variant="warning"
        size="compact"
        title="Interacting with an unverified vault"
        :description="`This batch interacts with an unverified vault (${unverifiedVaultNames.join(', ')}). Proceeding with an unknown and unverified vault may pose security risks — such vaults could potentially be used for phishing attempts.`"
      />

      <!-- Top-level batch error (revert / status-check / wallet shortfall) -->
      <BatchAlert
        v-if="simError || execError || insufficientBalanceMessage"
        :message="execError || simError || insufficientBalanceMessage"
      />

      <UiAlert
        v-if="prepareError"
        variant="error"
        size="compact"
        title="Preparation failed"
        :description="prepareError"
      />

      <!-- Secondary actions: copy calldata + Tenderly -->
      <div class="flex items-center justify-center gap-16">
        <button
          type="button"
          class="flex items-center gap-6 text-p3 text-content-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="batch-copy-calldata"
          :disabled="isCalldataCopyDisabled"
          @click="copyCalldata"
        >
          <SvgIcon
            :name="copied ? 'check' : 'copy'"
            class="!w-16 !h-16"
          />
          {{ copied ? 'Copied!' : isPreparing ? 'Preparing calldata…' : 'Copy calldata' }}
        </button>
        <template v-if="tenderlyEnabled">
          <a
            v-if="tenderlyUrl"
            :href="tenderlyUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="flex items-center gap-6 text-p3 transition-colors"
            :class="hasTenderlyFailed ? 'text-error-500' : 'text-success-500 hover:text-success-600'"
          >
            <SvgIcon
              :name="hasTenderlyFailed ? 'warning-circle' : 'check-circle'"
              class="!w-16 !h-16"
            />
            {{ hasTenderlyFailed ? 'Simulation reverted — view on Tenderly' : 'View simulation on Tenderly' }}
            <SvgIcon
              name="arrow-top-right"
              class="!w-14 !h-14"
            />
          </a>
          <button
            v-else
            type="button"
            class="flex items-center gap-6 text-p3 text-content-secondary hover:text-content-primary transition-colors disabled:opacity-50"
            :disabled="isTenderlySimulating"
            @click="simulateOnTenderly"
          >
            <SvgIcon
              :name="isTenderlySimulating ? 'loading' : 'arrow-top-right'"
              class="!w-16 !h-16"
              :class="{ 'animate-spin': isTenderlySimulating }"
            />
            {{ isTenderlySimulating ? 'Simulating…' : 'Simulate on Tenderly' }}
          </button>
        </template>
      </div>

      <div class="flex flex-col items-center gap-8">
        <UiButton
          variant="primary"
          size="xlarge"
          rounded
          :disabled="isConfirmDisabled"
          :loading="isExecuting || isPreparing"
          data-testid="batch-review-execute"
          @click="handleExecute"
        >
          {{ isExecuting ? 'Executing…' : 'Execute batch' }}
        </UiButton>
        <p
          v-if="blockedReason"
          class="text-p3 text-content-tertiary text-center"
        >
          {{ blockedReason }}
        </p>
      </div>
    </div>
  </BaseModalWrapper>
</template>
