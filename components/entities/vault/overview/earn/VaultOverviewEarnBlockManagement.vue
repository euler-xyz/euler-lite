<script setup lang="ts">
import type { EulerEarn } from '@eulerxyz/euler-v2-sdk'
import { DateTime } from 'luxon'
import { getAddress, zeroAddress, type Address } from 'viem'
import { eulerEarnPendingOwnerAbi } from '~/abis/euler-earn-governance'
import { formatTtl } from '~/utils/crypto-utils'
import { formatExactAmount } from '~/utils/string-utils'
import { getAssessmentFinding, getAssessmentSafeEvidence, getEarnAllocatorAddresses } from '~/utils/vault-assessment/evidence'

const { vault, defaultOpen = true } = defineProps<{ vault: EulerEarn, defaultOpen?: boolean }>()
const { assessment, fallbackReady } = useVaultAssessmentEvidence(() => vault.address, 'earn')
const { client } = useRpcClient()
const pendingOwner = shallowRef<Address | null>(null)
let pendingOwnerRequest = 0
watch([() => vault.address, client], async ([address, rpcClient]) => {
  const request = ++pendingOwnerRequest
  pendingOwner.value = null
  if (!rpcClient) return
  try {
    const result = await rpcClient.readContract({
      address: getAddress(address),
      abi: eulerEarnPendingOwnerAbi,
      functionName: 'pendingOwner',
      authorizationList: undefined,
    })
    if (request === pendingOwnerRequest && result !== zeroAddress) pendingOwner.value = result
  }
  catch {
    // Current ownership remains visible when this optional read fails.
  }
}, { immediate: true })
const safeEvidence = (address: string) => assessment.value || fallbackReady.value
  ? getAssessmentSafeEvidence(assessment.value, address)
  : null
const allocators = computed(() => getEarnAllocatorAddresses(assessment.value))
const timelockFinding = computed(() => getAssessmentFinding(assessment.value, 'governance.timelock'))

const formatValidAt = (seconds: number) => Number.isSafeInteger(seconds) && seconds > 0
  ? DateTime.fromSeconds(seconds).toLocaleString(DateTime.DATETIME_MED)
  : 'Date unavailable'
const pendingTimelock = computed(() => vault.governance.pendingTimelockValidAt > 0
  ? { value: vault.governance.pendingTimelock, validAt: vault.governance.pendingTimelockValidAt }
  : null)
const pendingGuardian = computed(() => vault.governance.pendingGuardianValidAt > 0
  ? { address: vault.governance.pendingGuardian, validAt: vault.governance.pendingGuardianValidAt }
  : null)
const pendingCaps = computed(() => vault.strategies.filter(strategy => strategy.allocationCap.pendingValidAt > 0))

const vaultAddressesInfo = computed(() => ([
  {
    title: `Owner`,
    address: vault.governance.owner,
  },
  {
    title: `Curator`,
    address: vault.governance.curator,
  },
  {
    title: `Guardian`,
    address: vault.governance.guardian,
  },
]))

const formatTimelock = (seconds: number): string => {
  if (seconds === 0) return '0 days'
  if (!Number.isSafeInteger(seconds) || seconds < 0) return 'Unknown'
  return formatTtl(BigInt(Math.floor(seconds / 86400)))?.display || 'Unknown'
}
const timelockDisplay = computed(() => formatTimelock(vault.governance.timelock))
</script>

<template>
  <VaultOverviewAccordionSection
    title="Governance"
    :default-open="defaultOpen"
    content-class="flex flex-col items-start gap-24"
  >
    <VaultOverviewLabelValue
      v-for="infoItem in vaultAddressesInfo"
      :key="infoItem.title"
      :label="infoItem.title"
      orientation="horizontal"
    >
      <VaultOverviewAddressValue
        :address="infoItem.address"
        check-safe
        :safe-evidence="safeEvidence(infoItem.address)"
      />
    </VaultOverviewLabelValue>
    <VaultOverviewLabelValue
      v-if="pendingOwner"
      label="Pending owner"
      orientation="horizontal"
    >
      <VaultOverviewAddressValue
        :address="pendingOwner"
        check-safe
      />
    </VaultOverviewLabelValue>
    <VaultOverviewLabelValue
      v-for="(allocator, index) in allocators"
      :key="`allocator-${allocator}`"
      :label="`Allocator ${index + 1}`"
      orientation="horizontal"
    >
      <VaultOverviewAddressValue
        :address="allocator"
        check-safe
        :safe-evidence="safeEvidence(allocator)"
      />
    </VaultOverviewLabelValue>
    <VaultOverviewLabelValue
      label="Timelock"
      orientation="horizontal"
    >
      <span class="pr-[22px]">
        {{ timelockDisplay }}
        <span
          v-if="timelockFinding?.outcome === 'fail'"
          class="text-warning-500"
        >· Below reviewed minimum</span>
      </span>
    </VaultOverviewLabelValue>
    <VaultOverviewLabelValue
      v-if="pendingTimelock"
      label="Pending timelock"
      orientation="horizontal"
    >
      <span>{{ formatTimelock(pendingTimelock.value) }} · valid {{ formatValidAt(pendingTimelock.validAt) }}</span>
    </VaultOverviewLabelValue>
    <VaultOverviewLabelValue
      v-if="pendingGuardian"
      label="Pending guardian"
      orientation="horizontal"
    >
      <div class="flex flex-col items-end gap-4">
        <span v-if="pendingGuardian.address.toLowerCase() === zeroAddress">Guardian removal</span>
        <VaultOverviewAddressValue
          v-else
          :address="pendingGuardian.address"
          check-safe
        />
        <span class="text-p3 text-content-tertiary">Valid {{ formatValidAt(pendingGuardian.validAt) }}</span>
      </div>
    </VaultOverviewLabelValue>
    <VaultOverviewLabelValue
      v-for="strategy in pendingCaps"
      :key="`cap-${strategy.address}`"
      label="Pending strategy cap"
      orientation="horizontal"
    >
      <div class="flex flex-col items-end gap-4">
        <VaultOverviewAddressValue :address="strategy.address" />
        <span class="text-p3 text-content-tertiary">
          {{ formatExactAmount(strategy.allocationCap.pending, strategy.vault?.asset.decimals ?? vault.asset.decimals, vault.asset.symbol) }}
          · valid {{ formatValidAt(strategy.allocationCap.pendingValidAt) }}
        </span>
      </div>
    </VaultOverviewLabelValue>
    <VaultOverviewLabelValue
      v-if="vault.supplyQueue.length"
      label="Supply queue"
      orientation="horizontal"
    >
      <div class="flex flex-col items-end gap-8">
        <VaultOverviewAddressValue
          v-for="address in vault.supplyQueue"
          :key="address"
          :address="address"
        />
      </div>
    </VaultOverviewLabelValue>
    <VaultOverviewLabelValue
      v-if="vault.withdrawQueue.length"
      label="Withdraw queue"
      orientation="horizontal"
    >
      <div class="flex flex-col items-end gap-8">
        <VaultOverviewAddressValue
          v-for="address in vault.withdrawQueue"
          :key="address"
          :address="address"
        />
      </div>
    </VaultOverviewLabelValue>
  </VaultOverviewAccordionSection>
</template>
