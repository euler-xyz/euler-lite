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
    <div class="divide-y divide-euler-dark-600">
      <div class="flex items-center justify-between py-16">
        <div>
          <div class="text-p2">
            Theme
          </div>
          <div class="text-p3 text-euler-dark-700">
            Follows system setting by default
          </div>
        </div>
        <UiSwitch
          :model-value="isDark"
          @update:model-value="toggleTheme"
        />
      </div>
      <div class="flex items-center justify-between py-16">
        <div>
          <div class="text-p2">
            Intrinsic APY
          </div>
          <div class="text-p3 text-euler-dark-700">
            Include intrinsic APY in displayed rates
          </div>
        </div>
        <UiSwitch
          :model-value="settings.enableIntrinsicApy"
          @update:model-value="updateSetting('enableIntrinsicApy', $event ?? false)"
        />
      </div>
      <div class="flex items-center justify-between py-16">
        <div>
          <div class="text-p2">
            Rewards
          </div>
          <div class="text-p3 text-euler-dark-700">
            Include token rewards in displayed rates
          </div>
        </div>
        <UiSwitch
          :model-value="settings.enableRewardsApy"
          @update:model-value="updateSetting('enableRewardsApy', $event ?? false)"
        />
      </div>
      <Permit2Settings />
      <SlippageSettings />
    </div>
  </BaseModalWrapper>
</template>
