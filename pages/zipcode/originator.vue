<script setup lang="ts">
// Originator path entry — placeholder for now (spec is lender-side only).
// Standalone centered screen, matching the landing's chrome-light treatment.
definePageMeta({ layout: false })
useHead({ title: 'Originator · Zip Code Finance' })
</script>

<template>
  <div class="zipcode-theme min-h-screen w-full flex items-center justify-center p-24">
    <section class="w-full max-w-[520px] text-center">
      <span
        class="inline-grid place-items-center w-48 h-48 rounded-14 mb-20"
        style="background: var(--zip-brand-soft); color: #1f7a45"
      >
        <SvgIcon
          name="bank"
          class="w-24 h-24"
        />
      </span>
      <p class="zip-eyebrow mb-10">
        Originator journey
      </p>
      <h1 class="zip-display text-[34px]">
        Coming soon
      </h1>
      <p
        class="mt-12 text-[16px]"
        style="color: var(--zip-text-muted)"
      >
        The originator workspace — KYB &amp; licensing, warehouse credit lines, loan
        applications, and draws — will live here.
      </p>

      <ul class="flex flex-col gap-10 mt-24 text-left max-w-[360px] mx-auto">
        <li
          v-for="item in ['Warehouse credit lines', 'Loan application pipeline', 'Draws & repayments']"
          :key="item"
          class="flex items-center gap-10 text-[14px]"
          style="color: var(--zip-text-muted)"
        >
          <span
            class="w-6 h-6 rounded-full shrink-0"
            style="background: var(--zip-brand)"
          />
          <span>{{ item }}</span>
        </li>
      </ul>

      <UiButton
        variant="primary-stroke"
        class="mt-28"
        to="/zipcode"
      >
        Back to paths
      </UiButton>
    </section>
  </div>
</template>
