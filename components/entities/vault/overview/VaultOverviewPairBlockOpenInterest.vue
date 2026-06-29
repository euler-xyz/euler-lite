<script setup lang="ts">
import type { PortfolioBorrowPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import { getPairBorrowVault } from '~/utils/borrow-pair'

const { pair, defaultOpen = false } = defineProps<{
  pair: AnyBorrowVaultPair | PortfolioBorrowPosition<VaultEntity>
  defaultOpen?: boolean
}>()

const borrowVault = computed(() => getPairBorrowVault(pair))
</script>

<template>
  <VaultOverviewBlockOpenInterest
    :vault="borrowVault"
    :default-open="defaultOpen"
  />
</template>
