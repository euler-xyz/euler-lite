<script setup lang="ts">
const { isDark, toggleTheme } = useTheme()
const { settings, updateSetting } = useUserSettings()

defineEmits(['close'])
</script>

<template>
  <BaseModalWrapper
    title="Settings"
    @close="$emit('close')"
  >
    <div class="mb-20 rounded-16 border border-line-default bg-card p-16">
      <div class="flex items-center justify-between">
        <div>
          <div class="text-p2">
            Theme
          </div>
          <div class="text-p3 text-content-muted">
            Dark mode by default
          </div>
        </div>
        <UiSwitch
          :model-value="isDark"
          @update:model-value="toggleTheme"
        />
      </div>
    </div>
    <div class="mb-20 rounded-16 border border-line-default bg-card p-16">
      <div class="flex items-center justify-between">
        <div>
          <div class="text-p2">
            Intrinsic APY
          </div>
          <div class="text-p3 text-content-muted">
            Include intrinsic APY in displayed rates
          </div>
        </div>
        <UiSwitch
          :model-value="settings.enableIntrinsicApy"
          @update:model-value="updateSetting('enableIntrinsicApy', $event ?? false)"
        />
      </div>
    </div>
    <div class="mb-20 rounded-16 border border-line-default bg-card p-16">
      <div class="flex items-center justify-between">
        <div>
          <div class="text-p2">
            Rewards
          </div>
          <div class="text-p3 text-content-muted">
            Include token rewards in displayed rates
          </div>
        </div>
        <UiSwitch
          :model-value="settings.enableRewardsApy"
          @update:model-value="updateSetting('enableRewardsApy', $event ?? false)"
        />
      </div>
    </div>
    <div class="mb-20 rounded-16 border border-line-default bg-card p-16">
      <div class="flex items-center justify-between">
        <div>
          <div class="text-p2">
            Batch transactions
          </div>
          <div class="text-p3 text-content-muted">
            Queue multiple actions into one atomic transaction
          </div>
        </div>
        <UiSwitch
          :model-value="settings.enableBatchTransactions"
          @update:model-value="updateSetting('enableBatchTransactions', $event ?? false)"
        />
      </div>
    </div>
    <Permit2Settings />
    <SlippageSettings />
  </BaseModalWrapper>
</template>
