<script setup lang="ts">
const { signaturesEnabled, setSignaturesEnabled } = useSignaturePreference()

const onToggle = (value: boolean | undefined) => {
  setSignaturesEnabled(value ?? false)
}
</script>

<template>
  <div class="mb-20 rounded-16 border border-line-default bg-card p-16">
    <div class="flex items-center justify-between">
      <div>
        <div class="text-p2">
          Gasless signatures
        </div>
        <div class="text-p3 text-content-muted">
          Use gasless message signatures instead of approval transactions
        </div>
      </div>
      <UiSwitch
        :model-value="signaturesEnabled"
        @update:model-value="onToggle"
      />
    </div>
  </div>
</template>
