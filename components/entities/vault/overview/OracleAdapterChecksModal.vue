<script setup lang="ts">
import { OracleAdapterCheckSeverity, type OracleAdapterCheck } from '~/entities/oracle'

defineEmits(['close'])

const {
  modalTitle = 'Checks',
  checks,
  inline = false,
  close = true,
} = defineProps<{
  modalTitle?: string
  checks: OracleAdapterCheck[]
  inline?: boolean
  close?: boolean
}>()
</script>

<template>
  <BaseModalWrapper
    :title="modalTitle"
    :inline="inline"
    :close="close"
    :compact="inline && !close"
    @close="$emit('close')"
  >
    <div class="flex flex-col gap-10">
      <div
        v-for="(check, i) in checks"
        :key="`${check.id}-${i}`"
        class="flex items-start gap-10"
      >
        <span
          class="flex-shrink-0 w-20 h-20 rounded-full flex items-center justify-center mt-8"
          :class="{
            'bg-success-500': check.pass,
            'bg-error-500': !check.pass && check.severity === OracleAdapterCheckSeverity.High,
            'bg-warning-500': !check.pass && check.severity !== OracleAdapterCheckSeverity.High,
          }"
        >
          <SvgIcon
            :name="check.pass ? 'check' : 'close'"
            class="!w-10 !h-10 text-white"
          />
        </span>
        <div class="min-w-0">
          <p class="text-p3 font-medium text-content-primary break-words">
            {{ check.id }}
          </p>
          <p class="text-p3 text-content-secondary break-words">
            {{ check.message }}
          </p>
        </div>
      </div>
    </div>
  </BaseModalWrapper>
</template>
