<script setup lang="ts">
const props = defineProps<{
  onAccept?: () => void
  onReject?: () => void
}>()
const emits = defineEmits(['close'])

const { tosUrl, privacyPolicyUrl, riskDisclosuresUrl } = useDeployConfig()

const terms = [
  {
    icon: 'map-pin-off',
    text: `I am not a resident of, located in, or incorporated in any Restricted Jurisdiction. I will not access this site or use our products or services while in any restricted locations, nor use a VPN to mask my location.`,
  },
  {
    icon: 'globe',
    text: `I am permitted to access this site and use Euler software under the laws of my jurisdiction.`,
  },
  {
    icon: 'search-user',
    text: `I am not a Sanctioned Person (as defined in the ToU) nor acting on behalf of one.`,
  },
  {
    icon: 'shield',
    text: `The App, Protocol, and related software are experimental and may result in complete loss of funds. The company and its affiliates do not custody or control user assets or transactions; liquidations are performed by the protocol or its users.`,
  },
  {
    icon: 'chart',
    text: `I understand the risks of decentralised finance and engaging with blockchain and other web3 software and services, including technical, operational, market, liquidity, and legal risks.`,
  },
  {
    icon: 'governed',
    text: `I acknowledge that Safe Harbor programs have separate rules, and by using the Protocol, I consent to the Whitehat Agreement terms, including eligible fund rescues, bounty deductions, associated risks (including loss and taxes), and holding Euler Community Members harmless.`,
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
    title="Acknowledge terms"
    @close="onReject"
  >
    <div class="flex flex-col gap-24 full flex-grow min-h-0">
      <div class="text-p3 text-content-secondary">
        By accessing or using Euler's products and services, I agree to the
        <a
          :href="tosUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="text-accent-500 underline cursor-pointer hover:text-accent-600"
        >Terms of Use</a>,
        <a
          :href="privacyPolicyUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="text-accent-500 underline cursor-pointer hover:text-accent-600"
        >Privacy Policy</a>, and
        <a
          :href="riskDisclosuresUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="text-accent-500 underline cursor-pointer hover:text-accent-600"
        >Risk Disclosures</a>.
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
