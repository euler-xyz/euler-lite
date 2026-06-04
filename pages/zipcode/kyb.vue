<script setup lang="ts">
// Lender KYB stub (spec demo) — gate before the deposit flow, adapted from the
// worktree. Mocked approval flips kybStatus via useZipDemo().approveKyb().
import { demoConfig } from '~/types/zipcode'

definePageMeta({ layout: 'zipcode' })
useHead({ title: 'Lender verification · Zip Code Finance' })

const { state, approveKyb } = useZipDemo()
const approved = computed(() => state.value.kybStatus === 'approved')

const reviewRows = computed(() => [
  { label: 'Institution', value: demoConfig.institutionName },
  { label: 'Authorized user', value: demoConfig.lenderName },
  { label: 'Account email', value: demoConfig.lenderEmail },
  { label: 'Status', value: approved.value ? 'Approved' : 'Ready' },
])

const checklist = [
  'Institution profile reviewed',
  'Authorized user confirmed',
  'Funding source marked available',
  'Lender operations unlocked',
]
</script>

<template>
  <div>
    <NuxtLink
      to="/zipcode"
      class="inline-flex items-center gap-6 text-[13px] mb-20"
      style="color: var(--zip-text-muted)"
    >
      <SvgIcon
        name="arrow-left"
        class="w-14 h-14"
      />
      Back to paths
    </NuxtLink>

    <div class="grid grid-cols-[1fr_0.8fr] gap-24 items-start mobile:grid-cols-1">
      <!-- Main -->
      <section class="zip-card p-28">
        <p class="zip-eyebrow mb-10">
          Lender verification
        </p>
        <h1 class="zip-display text-[34px]">
          Complete KYB first
        </h1>
        <p
          class="mt-12 text-[15px] max-w-[460px]"
          style="color: var(--zip-text-muted)"
        >
          Before depositing funds, requesting redemption, or claiming USDC, the
          lender account must be approved for the demo.
        </p>

        <dl
          class="zip-card-flat divide-y mt-20"
          style="--tw-divide-opacity: 1"
        >
          <div
            v-for="row in reviewRows"
            :key="row.label"
            class="flex items-center justify-between gap-12 px-16 py-12 border-b last:border-b-0"
            style="border-color: var(--zip-border)"
          >
            <dt
              class="text-[14px]"
              style="color: var(--zip-text-muted)"
            >
              {{ row.label }}
            </dt>
            <dd class="text-[14px] font-semibold tabular-nums text-right">
              {{ row.value }}
            </dd>
          </div>
        </dl>

        <div class="flex flex-wrap items-center gap-12 mt-24">
          <UiButton
            v-if="approved"
            size="large"
            to="/zipcode/earn"
          >
            Continue to Earn
          </UiButton>
          <UiButton
            v-else
            size="large"
            @click="approveKyb"
          >
            Submit demo KYB
          </UiButton>
          <UiButton
            variant="primary-stroke"
            size="large"
            to="/zipcode/protocol"
          >
            View protocol health
          </UiButton>
        </div>
      </section>

      <!-- Checklist -->
      <aside class="zip-card-muted p-24">
        <h2 class="zip-display text-[20px] mb-16">
          Demo checklist
        </h2>
        <ul class="flex flex-col gap-12">
          <li
            v-for="(item, index) in checklist"
            :key="item"
            class="flex items-start gap-10 text-[14px]"
          >
            <SvgIcon
              name="check"
              class="w-18 h-18 shrink-0 mt-0.5"
              :style="(approved || index < 2) ? 'color: var(--zip-brand-strong)' : 'color: var(--zip-border)'"
            />
            <span style="color: var(--zip-text)">{{ item }}</span>
          </li>
        </ul>
        <div
          v-if="approved"
          class="zip-card-flat p-16 mt-16"
        >
          <p class="text-[14px] font-medium">
            KYB approved
          </p>
          <p
            class="text-[13px] mt-2"
            style="color: var(--zip-text-muted)"
          >
            This approval is mocked for the presentation.
          </p>
        </div>
      </aside>
    </div>
  </div>
</template>
