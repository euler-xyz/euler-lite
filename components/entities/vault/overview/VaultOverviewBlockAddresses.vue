<script setup lang="ts">
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { getVaultHookTarget } from '~/utils/vault-hooks'
import { isVaultBorrowable } from '~/utils/vault/classification'
import { getAssessmentSafeEvidence, getRouterGovernorEvidence } from '~/utils/vault-assessment/evidence'

const { vault, defaultOpen = true } = defineProps<{ vault: EVault, defaultOpen?: boolean }>()

// Surface borrow-side addresses while debt is being wound down, not only while
// new borrows are allowed (see isVaultBorrowable).
const isBorrowable = computed(() => isVaultBorrowable(vault))

const interestRateModelAddress = computed(() =>
  vault.interestRateModel.address,
)

const oracleRouterAddress = computed(() =>
  vault.oracle.name === 'EulerRouter' ? vault.oracle.oracle : null,
)

const { assessment, fallbackReady } = useVaultAssessmentEvidence(() => vault.address, 'evk')
const routerGovernorEvidence = computed(() => getRouterGovernorEvidence(assessment.value))
const { governor: rpcOracleGovernor } = useOracleRouterGovernor(oracleRouterAddress, () => fallbackReady.value && routerGovernorEvidence.value === undefined)
const oracleGovernor = computed(() => routerGovernorEvidence.value ?? rpcOracleGovernor.value)
const safeEvidence = (address: string) => assessment.value || fallbackReady.value
  ? getAssessmentSafeEvidence(assessment.value, address)
  : null

const vaultAddresesInfo = computed(() => {
  const baseAddresses: Array<{ title: string, address?: string, checkSafe?: boolean }> = [
    {
      title: `${vault.asset.symbol} token`,
      address: vault.asset.address,
    },
    {
      title: `${vault.asset.symbol} vault`,
      address: vault.address,
    },
  ]

  if (isBorrowable.value) {
    baseAddresses.push(
      {
        title: `${vault.asset.symbol} debt`,
        address: vault.dToken,
      },
    )
  }

  baseAddresses.push(
    {
      title: `Curator`,
      address: vault.governorAdmin,
      checkSafe: true,
    },
  )

  if (isBorrowable.value) {
    baseAddresses.push(
      {
        title: `Fee receiver`,
        address: vault.fees.governorFeeReceiver,
        checkSafe: true,
      },
      {
        title: `Oracle router`,
        address: vault.oracle.oracle,
      },
    )

    if (oracleGovernor.value) {
      baseAddresses.push(
        {
          title: `Oracle governor`,
          address: oracleGovernor.value,
          checkSafe: true,
        },
      )
    }

    baseAddresses.push(
      {
        title: `Unit of account`,
        address: vault.unitOfAccount?.address,
      },
      {
        title: `Interest rate model`,
        address: interestRateModelAddress.value,
      },
    )
  }

  baseAddresses.push(
    {
      title: `Hook target`,
      address: getVaultHookTarget(vault),
    },
  )

  return baseAddresses.filter((item): item is { title: string, address: string, checkSafe?: boolean } => Boolean(item.address))
})
</script>

<template>
  <VaultOverviewAccordionSection
    title="Addresses"
    :default-open="defaultOpen"
    content-class="flex flex-col items-start gap-24"
  >
    <VaultOverviewLabelValue
      v-for="infoItem in vaultAddresesInfo"
      :key="infoItem.title"
      :label="infoItem.title"
      orientation="horizontal"
    >
      <template
        v-if="infoItem.title === 'Unit of account'"
        #label
      >
        <span class="flex items-center gap-4">
          Unit of account
          <UiHoverPreviewTooltip
            title="Unit of Account"
            text="The reference currency used to denominate prices for LTV and health calculations in this vault. Typically USD or ETH. All collateral and debt values are converted to this unit when determining account health."
            icon-class="text-content-muted hover:text-content-secondary"
          />
        </span>
      </template>
      <VaultOverviewAddressValue
        :address="infoItem.address"
        :check-safe="infoItem.checkSafe"
        :safe-evidence="infoItem.checkSafe ? safeEvidence(infoItem.address) : undefined"
      />
    </VaultOverviewLabelValue>
  </VaultOverviewAccordionSection>
</template>
