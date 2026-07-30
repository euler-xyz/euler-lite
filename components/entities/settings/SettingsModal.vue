<script setup lang="ts">
const { isDark, toggleTheme } = useTheme()
const { settings, updateSetting } = useUserSettings()

const advancedFeatures = [
  'Batch transactions: queue multiple actions into one atomic transaction',
  'Migrate Euler positions out to Aave v3 and Morpho',
]

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
      <div class="flex items-start justify-between gap-16">
        <div class="min-w-0">
          <div class="text-p2">
            Enable advanced mode
          </div>
          <ul class="mt-6 list-disc pl-16 text-p3 text-content-muted">
            <li
              v-for="feature in advancedFeatures"
              :key="feature"
            >
              {{ feature }}
            </li>
          </ul>
        </div>
        <UiSwitch
          class="shrink-0"
          :model-value="settings.enableAdvancedMode"
          @update:model-value="updateSetting('enableAdvancedMode', $event ?? false)"
        />
      </div>
    </div>
    <SignatureSettings />
    <SlippageSettings />
  </BaseModalWrapper>
</template>
