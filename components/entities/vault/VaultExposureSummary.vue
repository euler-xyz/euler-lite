<script setup lang="ts">
import type { Placement } from '@floating-ui/vue'
import { VaultExposureListModal, UiModalPreviewTrigger } from '#components'
import {
  sortVaultExposureDisplayItems,
  type ExposureValueState,
  type VaultExposureDisplayItem,
} from '~/utils/vault/exposure-display'

const {
  items,
  valueState = 'ready',
  maxVisible = 5,
  avatarSize = '20',
  title = 'Exposure',
  placement = 'top-end',
} = defineProps<{
  items: VaultExposureDisplayItem[]
  valueState?: ExposureValueState
  maxVisible?: number
  avatarSize?: '16' | '20' | '36' | '38' | '40' | '46'
  title?: string
  placement?: Placement
}>()

const sortedItems = computed(() => sortVaultExposureDisplayItems(items))
const visibleItems = computed(() => sortedItems.value.slice(0, maxVisible))
const hiddenCount = computed(() => Math.max(sortedItems.value.length - visibleItems.value.length, 0))

const modalData = computed(() => ({
  props: {
    items: sortedItems.value,
    title,
    valueState,
  },
}))
</script>

<template>
  <UiModalPreviewTrigger
    v-if="sortedItems.length"
    :component="VaultExposureListModal"
    :modal-data="modalData"
    :placement="placement"
    aria-label="Show exposure details"
  >
    <span
      class="vault-exposure-summary"
      :class="`vault-exposure-summary--${avatarSize}`"
      data-id="exposure-summary"
      :data-value="sortedItems.map(item => item.label ?? item.asset.symbol).join(',')"
    >
      <span
        v-for="item in visibleItems"
        :key="item.asset.address"
        class="vault-exposure-summary__avatar"
      >
        <AssetAvatar
          :asset="item.asset"
          :size="avatarSize"
        />
      </span>
      <span
        v-if="hiddenCount"
        class="vault-exposure-summary__more text-p2 text-content-primary"
      >
        +{{ hiddenCount }}
      </span>
    </span>
  </UiModalPreviewTrigger>
  <span
    v-else
    class="text-p2 text-content-primary"
  >
    -
  </span>
</template>

<style lang="scss" scoped>
.vault-exposure-summary {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  &__avatar {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
    border-radius: 999px;
    background: var(--bg-surface);
    border: 2px solid var(--bg-surface);
    margin-left: -7px;
  }

  &__avatar:first-child {
    margin-left: 0;
  }

  &__more {
    margin-left: 4px;
    white-space: nowrap;
  }

  &--16 &__avatar {
    margin-left: -5px;
  }

  &--36 &__avatar,
  &--38 &__avatar,
  &--40 &__avatar,
  &--46 &__avatar {
    margin-left: -12px;
  }
}
</style>
