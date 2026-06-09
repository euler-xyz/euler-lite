<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { encodeFunctionData, formatUnits, getAddress } from 'viem'
import { flattenBatchEntries, getSubAccountId, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { getEulerSdk } from '~/composables/useEulerSdk'
import { useTxBatch } from '~/composables/useTxBatch'
import { useTokenSymbolResolver } from '~/composables/useTokenSymbolResolver'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { getAssetLogoUrl } from '~/composables/useTokenList'
import { buildTransactionPlanDisplaySteps, type DisplayStep, type StepDecodingContext } from '~/utils/stepDecoding'
import { formatHealthScore, formatSmartAmount } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { logWarn } from '~/utils/errorHandling'

// Whole-batch review: required approvals, then the operations as rows that roll
// down to their details, the net wallet changes, a Tenderly simulation link,
// and one atomic Execute. Opened from the "Review batch" button in the drawer
// (and mobile page). The per-operation detail is the data captured at add-time;
// execution reuses the composable's executeBatch (the exact simulated plan).
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
  executeBatch,
  prepareBatchPlan,
  getMergedPlan,
  entryPlans,
  marketByEntryId,
  tenderlyEnabled,
  isTenderlySimulating,
  tenderlyUrl,
  tenderlyError,
  fetchTenderlyEnabled,
  simulateOnTenderly,
} = useTxBatch()

const { isSpyMode, spyAddress } = useSpyMode()
const { address: walletAddress, chainId: wagmiChainId } = useWagmi()
const { chainId: addressesChainId } = useEulerAddresses()
const { buildKnownSymbols, resolveSymbol } = useTokenSymbolResolver()
const { getVault, isVerifiedVault } = useVaultRegistry()
const { copied, copyToClipboard } = useClipboardCopy()
const owner = computed(() => (isSpyMode.value ? spyAddress.value : walletAddress.value) || '')
const chainId = computed(() => wagmiChainId.value ?? addressesChainId.value)

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

// Per-operation step list — the exact decoded steps the per-op review modal
// (opened by the row's (i) icon in the builder) shows, built from that op's
// contextual plan (entryPlans) and the review context captured at add-time.
// This is what an expanded row reveals.
const stepsByEntryId = computed<Record<string, DisplayStep[]>>(() => {
  const out: Record<string, DisplayStep[]> = {}
  for (const entry of entries.value) {
    const plan = entryPlans.value[entry.id]
    const ctx = entry.review as StepDecodingContext | undefined
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

// Resulting health per position the batch changes: compare each borrow
// position's health factor on the real (layer 0) vs the final simulated layer,
// and list those that move (with their Position tag and before → after score).
const healthSummary = computed<Array<{ label: string, before?: string, after: string }>>(() => {
  if (layers.value.length < 2) return []
  const base = new Map(
    (layers.value[0]?.portfolio?.borrows ?? []).map(p => [getAddress(p.subAccount).toLowerCase(), p.healthFactor]),
  )
  const finalBorrows = layers.value[layers.value.length - 1]?.portfolio?.borrows ?? []
  const out: Array<{ label: string, before?: string, after: string }> = []
  for (const pos of finalBorrows) {
    const sub = getAddress(pos.subAccount).toLowerCase()
    if (revertedSubAccounts.value.has(sub)) continue
    const beforeHf = base.get(sub)
    if (beforeHf !== undefined && beforeHf === pos.healthFactor) continue
    const label = positionTag(pos.subAccount) ?? 'Position'
    out.push({
      label,
      before: beforeHf !== undefined ? formatHealthScore(nanoToValue(beforeHf, 18)) : undefined,
      after: formatHealthScore(nanoToValue(pos.healthFactor ?? 0n, 18)),
    })
  }
  return out
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
// The prepared plan (with approvals resolved) backs "Copy calldata"; falls back
// to the simulated merged plan if preparation hasn't completed.
const preparedPlanRef = ref<TransactionPlan | undefined>()

onMounted(async () => {
  void fetchTenderlyEnabled()
  isPreparing.value = true
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
  }
  finally {
    isPreparing.value = false
  }
})

const formatWalletChange = (change: { delta: bigint, decimals: number, symbol: string }) => {
  const negative = change.delta < 0n
  const abs = negative ? -change.delta : change.delta
  const amount = formatSmartAmount(formatUnits(abs, change.decimals))
  return `${negative ? '−' : '+'}${amount} ${change.symbol}`
}

// Copy the exact batch calldata (one entry per on-chain tx: approvals + the EVC
// batch), matching the per-operation review modals. Uses the prepared plan when
// available so approval txs are included, else the simulated merged plan.
const copyCalldata = async () => {
  const plan = preparedPlanRef.value ?? getMergedPlan()
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
  isSpyMode.value || isExecuting.value || isPreparing.value || isSimulating.value || !canExecuteBatch.value,
)
const blockedReason = computed(() => {
  if (isSpyMode.value) return 'Connect a wallet to execute — disabled in spy mode'
  if (hasFailedOps.value) return 'Resolve the reverting operation to execute'
  if (hasInsufficientBalance.value) return 'Not enough balance to execute this batch'
  if (simError.value) return 'This batch would revert — resolve the flagged error'
  return ''
})

const handleExecute = async () => {
  if (isConfirmDisabled.value) return
  await executeBatch()
  // executeBatch clears the cart on success; close once nothing's left to do.
  if (!execError.value && entries.value.length === 0) emit('close')
}
</script>

<template>
  <BaseModalWrapper
    title="Review batch"
    @close="!isExecuting && emit('close')"
  >
    <!-- Separator under the modal title -->
    <div class="-mx-16 mb-16 border-t border-line-default" />
    <div class="flex flex-col gap-20">
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
                class="mb-8 px-12"
              />
              <!-- Same decoded operation steps the per-op review modal shows
                   (the builder row's (i) icon). -->
              <div
                v-if="stepsByEntryId[entry.id]?.length"
                class="bg-card rounded-8 p-12 flex flex-col gap-8"
              >
                <OperationStepsList :steps="stepsByEntryId[entry.id]" />
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

      <!-- Wallet changes -->
      <div
        v-if="walletChanges.length"
        class="bg-surface-elevated rounded-12 px-12 py-10"
      >
        <p class="text-p3 text-content-tertiary mb-6">
          Wallet changes
        </p>
        <ul class="flex flex-col gap-4">
          <li
            v-for="change in walletChanges"
            :key="change.token"
            class="flex items-center justify-between text-p3"
          >
            <span class="text-content-secondary">{{ change.symbol || 'Token' }}</span>
            <span
              class="tabular-nums"
              :class="change.delta < 0n ? 'text-error-300' : 'text-accent-500'"
            >
              {{ formatWalletChange(change) }}
            </span>
          </li>
        </ul>
      </div>

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

      <!-- Top-level batch error -->
      <BatchAlert
        v-if="simError || execError"
        :message="execError || simError || ''"
      />

      <!-- Secondary actions: copy calldata + Tenderly -->
      <div class="flex items-center justify-center gap-16">
        <button
          type="button"
          class="flex items-center gap-6 text-p3 text-content-primary transition-colors"
          data-testid="batch-copy-calldata"
          @click="copyCalldata"
        >
          <SvgIcon
            :name="copied ? 'check' : 'copy'"
            class="!w-16 !h-16"
          />
          {{ copied ? 'Copied!' : 'Copy calldata' }}
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
