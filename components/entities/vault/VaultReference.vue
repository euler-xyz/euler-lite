<script setup lang="ts">
const props = withDefaults(defineProps<{
  address: string
  /** The address as the check's sentence wrote it, kept while the name is unknown. */
  fallback?: string
  /** Off inside a row that is itself a link. */
  linkable?: boolean
}>(), { linkable: true })

const { describe } = useVaultReferences()
const reference = computed(() => describe(props.address, props.fallback))
const { isCopied, copyToClipboard } = useClipboardCopy()
const copyAddress = () => {
  copyToClipboard(props.address).catch(() => {})
}
</script>

<template>
  <span
    class="inline-flex items-center gap-2 align-baseline"
    data-id="vault-reference"
    :data-address="address.toLowerCase()"
    :data-kind="reference.kind"
  >
    <NuxtLink
      v-if="linkable && reference.to"
      :to="reference.to"
      class="underline decoration-dotted outline-none hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600"
      :title="address"
      @click.stop
    >{{ reference.label }}</NuxtLink>
    <span
      v-else
      :title="address"
    >{{ reference.label }}</span>
    <button
      type="button"
      class="inline-flex items-center outline-none hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600"
      :title="isCopied(address) ? 'Copied' : 'Copy full address'"
      :aria-label="`Copy address ${address}`"
      @mousedown.stop.prevent
      @click.stop.prevent="copyAddress"
    >
      <SvgIcon
        class="!w-14 !h-14"
        :name="isCopied(address) ? 'check' : 'copy'"
      />
    </button>
  </span>
</template>
