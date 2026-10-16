<script setup lang="ts">
import type { VaultCheckRowView } from '~/utils/vault-assessment/check-rows'

const props = defineProps<{ row: VaultCheckRowView }>()

const TONE_BACKGROUND = { pass: 'bg-success-500', warning: 'bg-warning-500', error: 'bg-error-500', muted: 'bg-content-muted' } as const
const TONE_TEXT = { pass: 'text-success-500', warning: 'text-warning-500', error: 'text-error-500', muted: 'text-content-muted' } as const
const TONE_SEVERITY = { error: 0, warning: 1, pass: 2, muted: 3 } as const

const lead = computed(() => props.row.checks.reduce((worst, check) => TONE_SEVERITY[check.tone] < TONE_SEVERITY[worst.tone] ? check : worst))
const details = computed(() => props.row.subject
  ? props.row.checks.filter(check => check.parts.length || check.tag)
  : props.row.checks.filter(check => check.parts.length))
const listsChecks = computed(() => !!props.row.subject && props.row.checks.length > 1)
const namesCheck = (parts: unknown[]) => listsChecks.value && (details.value.length > 1 || !parts.length)
</script>

<template>
  <div
    class="flex items-start gap-10"
    data-id="vault-check-row"
    :data-key="row.key"
  >
    <span
      class="flex-shrink-0 w-20 h-20 rounded-full flex items-center justify-center mt-2"
      :class="TONE_BACKGROUND[lead.tone]"
      :data-tone="lead.tone"
    >
      <SvgIcon
        :name="lead.icon"
        class="!w-10 !h-10 text-white"
      />
    </span>
    <div class="min-w-0 flex flex-col gap-2">
      <p
        v-if="row.subject"
        class="text-p3 text-content-primary break-words"
      >
        <VaultReference
          class="text-accent-600"
          :address="row.subject.address"
        />
        <span
          v-if="!listsChecks"
          class="font-medium"
          data-id="vault-check-finding"
          :data-key="lead.key"
          :data-tone="lead.tone"
        > · {{ lead.title }}<span class="sr-only">: {{ lead.status }}</span></span>
        <span
          v-if="row.weight"
          class="ml-6 text-p4 text-content-tertiary"
          data-id="vault-check-weight"
        >{{ row.weight }}</span>
      </p>
      <p
        v-else
        class="text-p3 font-medium text-content-primary break-words"
        data-id="vault-check-finding"
        :data-key="lead.key"
        :data-tone="lead.tone"
      >
        {{ lead.title }}<span class="sr-only">: {{ lead.status }}</span>
        <span
          v-if="lead.tag"
          class="ml-4 text-p4 font-normal text-content-tertiary"
          data-id="vault-check-tag"
        >{{ lead.tag }}</span>
      </p>
      <ul
        v-if="listsChecks"
        class="flex flex-wrap items-center gap-x-10 gap-y-2 text-p4 text-content-secondary"
      >
        <li
          v-for="(check, index) in row.checks"
          :key="`${check.key}-${index}`"
          class="inline-flex items-center gap-4"
          data-id="vault-check-finding"
          :data-key="check.key"
          :data-tone="check.tone"
        >
          <SvgIcon
            :name="check.icon"
            class="!w-12 !h-12"
            :class="TONE_TEXT[check.tone]"
          />
          {{ check.title }}<span class="sr-only">: {{ check.status }}</span>
        </li>
      </ul>
      <p
        v-for="(check, index) in details"
        :key="`${check.key}-${index}:detail`"
        class="text-p3 text-content-secondary break-words"
      >
        <span
          v-if="namesCheck(check.parts)"
          class="font-medium text-content-primary"
        >{{ check.title }}: </span>
        <template
          v-for="(part, partIndex) in check.parts"
          :key="partIndex"
        >
          <VaultReference
            v-if="part.address"
            class="text-accent-600"
            :address="part.address"
            :fallback="part.text"
          />
          <template v-else>
            {{ part.text }}
          </template>
        </template>
        <span
          v-if="row.subject && check.tag"
          class="ml-4 text-p4 text-content-tertiary"
          data-id="vault-check-tag"
        >{{ check.tag }}</span>
      </p>
    </div>
  </div>
</template>
