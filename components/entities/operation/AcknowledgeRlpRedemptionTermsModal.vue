<script setup lang="ts">
const props = defineProps<{
  onAccept?: () => void
  onReject?: () => void
}>()
const emits = defineEmits(['close'])

const { rlpTouMdUrl } = useDeployConfig()

const terms = [
  {
    icon: 'file-text',
    text: `I have read and understood the additional Terms of Use governing the RLP redemption process.`,
  },
  {
    icon: 'shield',
    text: `I acknowledge that the RLP redemption process is subject to specific conditions and risks beyond those covered by the general Terms of Use.`,
  },
  {
    icon: 'chart',
    text: `I understand that the outcome of redemption depends on the redemption process rules, available liquidity, and other factors outside of my direct control.`,
  },
  {
    icon: 'governed',
    text: `By proceeding, I accept these additional terms in addition to the Terms of Use, Privacy Policy, and Risk Disclosures I have previously acknowledged.`,
  },
]

const onReject = () => {
  if (props.onReject) {
    props.onReject()
  }
  emits('close')
}
const onAccept = () => {
  if (props.onAccept) {
    props.onAccept()
  }
  emits('close')
}
</script>

<template>
  <BaseModalWrapper
    full
    title="Acknowledge RLP redemption terms"
    @close="onReject"
  >
    <div class="flex flex-col gap-24 full flex-grow min-h-0">
      <div class="text-p3 text-content-secondary">
        By proceeding to interact with this vault, I agree to the
        <a
          :href="rlpTouMdUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="text-accent-500 underline cursor-pointer hover:text-accent-600"
        >additional Terms of Use for the RLP redemption process</a>.
        I further represent and warrant:
      </div>

      <div class="bg-surface-secondary rounded-12 overflow-y-auto flex-1 styled-scrollbar">
        <div
          v-for="(term, index) in terms"
          :key="index"
          class="flex gap-16 p-16"
          :class="[index !== terms.length - 1 ? 'border-b border-line-subtle' : '']"
        >
          <div class="bg-surface rounded-8 flex items-center justify-center w-48 h-48 flex-shrink-0">
            <UiIcon
              :name="term.icon"
              class="text-content-tertiary"
            />
          </div>
          <div class="text-p3 text-content-primary">
            {{ term.text }}
          </div>
        </div>
      </div>

      <div class="flex gap-8">
        <UiButton
          variant="primary-stroke"
          size="xlarge"
          rounded
          @click="onReject"
        >
          Reject
        </UiButton>
        <UiButton
          variant="primary"
          size="xlarge"
          rounded
          @click="onAccept"
        >
          Accept
        </UiButton>
      </div>
    </div>
  </BaseModalWrapper>
</template>
