<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { encodeFunctionData, getAddress } from 'viem'
import { flattenBatchEntries, getSubAccountId, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { getEulerSdk } from '~/composables/useEulerSdk'
import { buildModifiedPositionKeySets, buildRemovedPositionKeySets, filterPositionKeysByOwner, useTxBatch } from '~/composables/useTxBatch'
import { useTokenSymbolResolver } from '~/composables/useTokenSymbolResolver'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { getAssetLogoUrl } from '~/composables/useTokenList'
import { buildTransactionPlanDisplaySteps, type DisplayStep, type StepDecodingContext } from '~/utils/stepDecoding'
import { logWarn } from '~/utils/errorHandling'
import { buildBatchHealthSummary } from '~/utils/batchHealthSummary'
import { hasPermit2TokenApproval } from '~/utils/transactionPlanApprovals'
import { formatNumber } from '~/utils/string-utils'

// Whole-batch review: required approvals, then the operations as rows that roll
// down to their details, the net wallet changes, a Tenderly simulation link,
// and one atomic Execute. Opened from the "Review batch" button in the drawer
// (and mobile page). The per-operation detail is the data captured at add-time;
// execution is delegated to the composable's executeBatch.
const emit = defineEmits(['close'])

const {
  entries,
  layers,
  walletChanges,
  simError,
  execError,
  isExecuting,
  isSimulating,
  canExecuteBatch,
  hasFailedOps,
  hasInsufficientBalance,
  insufficientBalanceMessage,
  executeBatch,
  prepareBatchPlan,
  entryPlans,
  marketByEntryId,
  tenderlyEnabled,
  isTenderlySimulating,
  tenderlyUrl,
  tenderlyError,
  fetchTenderlyEnabled,
  simulateOnTenderly,
  dismissExecutionError,
} = useTxBatch()

const { isSpyMode, spyAddress } = useSpyMode()
const { address: walletAddress, chainId: wagmiChainId } = useWagmi()
const { chainId: addressesChainId, eulerCoreAddresses } = useEulerAddresses()
const { buildKnownSymbols, resolveSymbol } = useTokenSymbolResolver()
const { getVault, isVerifiedVault } = useVaultRegistry()
const { copied, copyToClipboard } = useClipboardCopy()
const owner = computed(() => (isSpyMode.value ? spyAddress.value : walletAddress.value) || '')
const chainId = computed(() => wagmiChainId.value ?? addressesChainId.value)
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
}

const isExternalProtocolMigrationReview = (review: ReviewWithSteps | undefined): boolean =>
  review?.type === 'migration'

const normalizeDisplaySteps = (steps: DisplayStep[] | undefined): DisplayStep[] =>
  (steps ?? []).map((step, idx) => ({ ...step, index: idx + 1 }))

const getEntrySignatureSteps = (entry: typeof entries.value[number]): DisplayStep[] => {
  const review = entry.review as unknown as ReviewWithSteps | undefined
  return isExternalProtocolMigrationReview(review)
    ? normalizeDisplaySteps(review?.signatureSteps)
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
      out[entry.id] = buildTransactionPlanDisplaySteps(plan, ctx, getVault, getAssetLogoUrl)
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

const signatureRows = computed(() =>
  entries.value.flatMap(entry =>
    (signatureStepsByEntryId.value[entry.id] ?? []).map(step => ({ entry, step })),
  ),
)

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

onMounted(async () => {
  void fetchTenderlyEnabled()
  isPreparing.value = true
  prepareError.value = ''
  try {
    const prepared = await prepareBatchPlan()
    preparedPlanRef.value = prepared?.plan
    const known = buildKnownSymbols()
    const out: Array<{ kind: 'approve' | 'permit', symbol: string }> = []
    for (const item of prepared?.plan ?? []) {
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

// Copy the exact batch calldata (one entry per on-chain tx: approvals + the EVC
// batch), matching the per-operation review modals. This requires the prepared
// plan so approval txs are included.
const isCalldataCopyDisabled = computed(() =>
  isPreparing.value || !!prepareError.value || !preparedPlanRef.value?.length,
)
const copyCalldata = async () => {
  const plan = preparedPlanRef.value
  if (!plan?.length) return
  try {
    const sdk = await getEulerSdk()
    const cid = chainId.value
    const out: { to: string, data: string, value: string }[] = []
    for (const item of plan) {
      if (item.type === 'requiredApproval') {
        for (const r of item.resolved ?? []) {
          if (r.type === 'approve') out.push({ to: r.token, data: r.data, value: '0' })
        }
        continue
      }
      if (item.type === 'evcBatch' && cid) {
        const items = flattenBatchEntries(item.items)
        const evc = sdk.deploymentService.getDeployment(cid).addresses.coreAddrs.evc
        const data = sdk.executionService.encodeBatch(items)
        const value = items.reduce((sum, it) => sum + it.value, 0n)
        out.push({ to: evc, data, value: value.toString() })
        continue
      }
      if (item.type === 'contractCall') {
        out.push({
          to: item.to,
          data: encodeFunctionData({ abi: item.abi, functionName: item.functionName, args: item.args }),
          value: item.value.toString(),
        })
      }
    }
    copyToClipboard(JSON.stringify(out, null, 2), 'calldata')
  }
  catch (error) {
    logWarn('BatchReviewModal/copyCalldata', error)
  }
}

const hasTenderlyFailed = computed(() => Boolean(tenderlyUrl.value && tenderlyError.value))

const isConfirmDisabled = computed(() =>
  isSpyMode.value || isExecuting.value || isPreparing.value || isSimulating.value || !canExecuteBatch.value || !!prepareError.value,
)
const blockedReason = computed(() => {
  if (isSpyMode.value) return 'Connect a wallet to execute — disabled in spy mode'
  if (hasFailedOps.value) return 'Resolve the reverting operation to execute'
  if (hasInsufficientBalance.value) return insufficientBalanceMessage.value || 'Not enough balance to execute this batch'
  if (simError.value) return 'This batch would revert — resolve the flagged error'
  return ''
})

const handleExecute = async () => {
  if (isConfirmDisabled.value) return
  await executeBatch()
  // executeBatch clears the cart on success; close once nothing's left to do.
  if (!execError.value && entries.value.length === 0) emit('close')
}

const handleClose = () => {
  dismissExecutionError()
  emit('close')
}
</script>

<template>
  <BaseModalWrapper
    title="Review batch"
    @close="!isExecuting && handleClose()"
  >
    <!-- Separator under the modal title -->
    <div class="-mx-16 mb-16 border-t border-line-default" />
    <div class="flex flex-col gap-20">
      <!-- Off-chain signatures captured by operations such as migrations. -->
      <div v-if="signatureRows.length">
        <p class="text-p3 text-content-tertiary uppercase tracking-[0.04em] mb-8">
          Signatures needed
        </p>
        <div class="bg-surface-secondary rounded-12 px-12 divide-y divide-line-default">
          <div
            v-for="({ entry, step }, i) in signatureRows"
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
            <span class="text-p3 text-content-tertiary shrink-0">1 signature</span>
          </div>
        </div>
      </div>

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
            <span class="text-p3 text-content-tertiary">{{ a.kind === 'permit' ? '1 signature' : 'bundled in batch' }}</span>
          </div>
        </div>
      </div>

      <UiAlert
        v-if="hasPermit2Approval"
        variant="warning"
        size="compact"
        title="Infinite approval"
        description="You are granting the Permit2 contract an unlimited token allowance. Permit2 is a Uniswap contract that lets you approve once, then sign per-action permissions without new onchain approvals."
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
              <!-- Same decoded operation steps the per-op review modal shows
                   (the builder row's (i) icon). -->
              <div
                v-if="signatureStepsByEntryId[entry.id]?.length || stepsByEntryId[entry.id]?.length"
                class="bg-card rounded-8 p-12 flex flex-col gap-8"
              >
                <template v-if="signatureStepsByEntryId[entry.id]?.length">
                  <p class="text-p4 text-content-tertiary uppercase tracking-[0.04em]">
                    Signatures
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
