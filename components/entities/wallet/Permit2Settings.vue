<script setup lang="ts">
const { permit2Enabled, setPermit2Enabled } = usePermit2Preference()

const onToggle = (value: boolean | undefined) => {
  setPermit2Enabled(value ?? false)
}
</script>

<template>
  <div class="flex items-center justify-between py-16">
    <div>
      <div class="text-p2">
        permit2 approvals
      </div>
      <div class="text-p3 text-euler-dark-700">
        Use gasless token approvals
      </div>
    </div>
    <UiSwitch
      :model-value="permit2Enabled"
      @update:model-value="onToggle"
    />
  </div>
</template>
