<script setup lang="ts">
import type { ActivityItem } from '~/types/zipcode'
import { formatCurrency, formatZipUsd, formatUsdc } from '~/types/zipcode'

const props = defineProps<{ items: ActivityItem[] }>()

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' })

const amount = (item: ActivityItem) => {
  if (item.amountZipUsd != null) return formatZipUsd(item.amountZipUsd)
  if (item.amountUsd != null) return formatCurrency(item.amountUsd)
  if (item.amountUsdc != null) return formatUsdc(item.amountUsdc)
  return '—'
}

const isEmpty = computed(() => props.items.length === 0)
</script>

<template>
  <div class="zip-card overflow-hidden">
    <div
      v-if="isEmpty"
      class="p-32 text-center text-[15px]"
      style="color: var(--zip-text-muted)"
    >
      No activity yet. Deposits, redemptions and claims will appear here.
    </div>

    <template v-else>
      <!-- Desktop table -->
      <table class="w-full mobile:hidden">
        <thead>
          <tr
            class="text-left text-[12px] uppercase tracking-wide"
            style="color: var(--zip-text-muted)"
          >
            <th class="px-20 py-12 font-medium">
              Date
            </th>
            <th class="px-20 py-12 font-medium">
              Activity
            </th>
            <th class="px-20 py-12 font-medium text-right">
              Amount
            </th>
            <th class="px-20 py-12 font-medium text-right">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="item in items"
            :key="item.id"
            class="border-t"
            style="border-color: var(--zip-border)"
          >
            <td
              class="px-20 py-14 text-[14px] tabular-nums"
              style="color: var(--zip-text-muted)"
            >
              {{ fmtDate(item.createdAt) }}
            </td>
            <td class="px-20 py-14 text-[14px] font-medium">
              {{ item.label }}
            </td>
            <td class="px-20 py-14 text-[14px] text-right tabular-nums font-medium">
              {{ amount(item) }}
            </td>
            <td class="px-20 py-14 text-right">
              <ZipStatusBadge
                v-if="item.status"
                :status="item.status"
              />
            </td>
          </tr>
        </tbody>
      </table>

      <!-- Mobile stacked cards -->
      <div class="hidden mobile:flex flex-col">
        <div
          v-for="item in items"
          :key="item.id"
          class="p-16 border-t first:border-t-0"
          style="border-color: var(--zip-border)"
        >
          <div class="flex items-center justify-between">
            <span class="text-[14px] font-medium">{{ item.label }}</span>
            <span class="text-[14px] font-medium tabular-nums">{{ amount(item) }}</span>
          </div>
          <div class="flex items-center justify-between mt-6">
            <span
              class="text-[13px]"
              style="color: var(--zip-text-muted)"
            >{{ fmtDate(item.createdAt) }}</span>
            <ZipStatusBadge
              v-if="item.status"
              :status="item.status"
            />
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
