<script setup lang="ts">
import AssetInput from '~/components/entities/asset/AssetInput.vue'
import type { VaultAsset } from '~/entities/vault'
import { useModal } from '~/components/ui/composables/useModal'
import { AcknowledgeTermsModal } from '#components'

const radioModel = ref('radio-test-1')
const tabsModel = ref(0)
const checkboxModel = ref(false)
const switchModel = ref(false)
const inputModel = ref('')
const inputWithValueModel = ref('Example value')
const inputErrorModel = ref('Error value')
const asset: VaultAsset = {
  name: 'Mock TON',
  decimals: 18n,
  symbol: 'mTON',
  address: '0xc981cd0aC047D1Bc55aF4B6A9cF7fA82465363D0',
}

const modal = useModal()
const openLegalModal = () => {
  modal.open(AcknowledgeTermsModal)
}
</script>

<template>
  <section>
    <div>
      <div class="p-16">
        <h3 class="text-h3 mb-16">
          Input Components
        </h3>

        <div class="mb-16">
          <UiInput
            v-model="inputModel"
            placeholder="Enter your email"
            label="Email"
            class="mb-16 max-w-[380px]"
          />
          <UiInput
            v-model="inputWithValueModel"
            placeholder="Search..."
            label="Search"
            class="mb-16 max-w-[380px]"
          />
          <UiInput
            v-model="inputModel"
            placeholder="Enter password"
            label="Password"
            type="password"
            help-text="Your password must be at least 8 characters"
            class="mb-16 max-w-[380px]"
          />
          <UiInput
            v-model="inputErrorModel"
            placeholder="Enter your email"
            label="Email (Error)"
            error
            help-text="Please enter a valid email address"
            class="mb-16 max-w-[380px]"
          />
          <UiInput
            v-model="inputModel"
            placeholder="Disabled input"
            label="Disabled"
            disabled
            class="mb-16 max-w-[380px]"
          />
        </div>

        <h3 class="text-h3 mb-16">
          Other Components
        </h3>

        <AssetInput
          :asset="asset"
          class="mb-16 max-w-[380px]"
        />

        <UiRange
          class="mb-16"
          label="Label"
        />
      </div>

      <div class="flex items-center gap-8 mb-16">
        <UiCheckbox
          v-model="checkboxModel"
          name="test"
          size="large"
          self-value="radio-test-1"
        />
        <UiCheckbox
          v-model="checkboxModel"
          name="test"
          self-value="radio-test-1"
        />
        <UiCheckbox
          v-model="checkboxModel"
          name="test"
          self-value="radio-test-1"
          disabled
        />
      </div>

      <div class="flex items-center gap-8 mb-16">
        <UiSwitch
          v-model="switchModel"
          name="switch"
        />
        <UiSwitch
          v-model="switchModel"
          name="switch"
          disabled
        />
      </div>

      <div class="mb-16">
        <UiTabs
          v-model="tabsModel"
          :list="[{
            label: 'Tab 1',
            value: 0,
          }, {
            label: 'Tab 2',
            value: 1,
            badge: '1',
          }, {
            label: 'Tab 3',
            value: 2,
          }]"
          label="Rounded"
          rounded
          class="mb-16"
        />
        <UiTabs
          v-model="tabsModel"
          :list="[{
            label: 'Tab 1',
            value: 0,
          }, {
            label: 'Tab 2',
            value: 1,
          }, {
            label: 'Tab 3',
            value: 2,
          }]"
          label="Pills"
          pills
        />
      </div>

      <div class="mb-16">
        <div class="mb-16">
          <UiButton
            variant="primary"
            size="large"
            icon="plus"
            rounded
            @click="openLegalModal"
          >
            Show Legal Modal
          </UiButton>
          <UiButton
            variant="primary-stroke"
            size="large"
            rounded
          >
            Primary Stroke Large
          </UiButton>
          <UiButton
            class="mb-8"
            variant="primary-stroke"
            size="large"
            icon="plus"
            loading
            rounded
          >
            Loading
          </UiButton>
        </div>
        <div class="mb-16">
          <UiButton
            variant="secondary"
            size="medium"
            icon="plus"
            rounded
          >
            Secondary Medium
          </UiButton>
          <UiButton
            variant="secondary-ghost"
            size="medium"
            rounded
          >
            Secondary Ghost Medium
          </UiButton>
        </div>
        <div class="mb-16">
          <UiButton
            variant="red"
            size="small"
            icon="plus"
            rounded
          >
            Red Small
          </UiButton>
          <UiButton
            variant="red-destructive"
            size="small"
            rounded
          >
            Red Destructive Small
          </UiButton>
        </div>
        <div class="mb-16">
          <UiButton
            class="mb-8"
            variant="primary"
            size="small"
            disabled
            rounded
          >
            Primary Medium Disabled
          </UiButton>
          <UiButton
            class="mb-8"
            variant="primary-stroke"
            size="small"
            disabled
            rounded
          >
            Primary Stroke Disabled
          </UiButton>
        </div>
        <div class="mb-16">
          <UiButton
            class="mb-8"
            variant="primary"
            size="large"
            icon="plus"
            icon-only
          />
          <UiButton
            class="mb-8"
            variant="primary-stroke"
            size="large"
            icon="plus"
            icon-only
          />
        </div>
      </div>

      <div class="text-h1">
        Headline 1
      </div>
      <div class="text-h2">
        Headline 2
      </div>
      <div class="text-h3">
        Headline 3
      </div>
      <div class="text-h4">
        Headline 4
      </div>
      <div class="text-h5">
        Headline 5
      </div>
      <div class="text-p1">
        Paragraph 1
      </div>
      <div class="text-p2">
        Paragraph 2
      </div>
      <div class="text-p3">
        Paragraph 3
      </div>
      <div class="text-white">
        White
      </div>
      <div class="text-black">
        Black
      </div>
      <div class="text-error-500">
        Error
      </div>
      <div class="text-success-500">
        Success
      </div>
      <div class="text-warning-500">
        Warning
      </div>
      <div class="text-accent-500">
        Accent
      </div>
      <SvgIcon
        class="!w-24 !h-24"
        name="close"
      />
      <SvgIcon
        class="!w-24 !h-24"
        name="copy"
      />
      <SvgIcon
        class="!w-24 !h-24"
        name="edit"
      />
      <SvgIcon
        class="!w-24 !h-24"
        name="filter"
      />
      <SvgIcon
        class="!w-24 !h-24"
        name="gas"
      />
      <SvgIcon
        class="!w-24 !h-24"
        name="health"
      />
      <SvgIcon
        class="!w-24 !h-24"
        name="loading"
      />
      <SvgIcon
        class="!w-24 !h-24"
        name="percent"
      />
      <SvgIcon
        class="!w-24 !h-24"
        name="plus"
      />
      <SvgIcon
        class="!w-24 !h-24"
        name="info-circle"
      />
      <SvgIcon
        class="!w-24 !h-24"
        name="search"
      />
      <SvgIcon
        class="!w-24 !h-24"
        name="shield"
      />
      <SvgIcon
        class="!w-24 !h-24"
        name="sparks"
      />
      <SvgIcon
        class="!w-24 !h-24"
        name="trash"
      />
      <SvgIcon
        class="!w-24 !h-24"
        name="unlink"
      />
      <SvgIcon
        class="!w-24 !h-24"
        name="wallet"
      />
      <SvgIcon
        class="!w-24 !h-24"
        name="warning-circle"
      />
      <SvgIcon
        class="!w-24 !h-24"
        name="arrow-down"
      />
      <SvgIcon
        class="!w-24 !h-24"
        name="arrow-top-right"
      />
      <SvgIcon
        class="!w-24 !h-24"
        name="lend-outline"
      />
      <SvgIcon
        class="!w-24 !h-24"
        name="lend-filled"
      />
      <SvgIcon
        class="!w-24 !h-24"
        name="borrow-outline"
      />
      <SvgIcon
        class="!w-24 !h-24"
        name="borrow-filled"
      />
      <SvgIcon
        class="!w-24 !h-24"
        name="portfolio-outline"
      />
      <SvgIcon
        class="!w-24 !h-24"
        name="portfolio-filled"
      />
      <UiIcon
        class="!w-24 !h-24"
        name="map-pin-off"
      />
      <UiIcon
        class="!w-24 !h-24"
        name="globe"
      />
      <UiIcon
        class="!w-24 !h-24"
        name="search-user"
      />
      <UiIcon
        class="!w-24 !h-24"
        name="chart"
      />
    </div>
    <div class="flex items-center mb-8">
      <UiRadio
        v-model="radioModel"
        name="test"
        label="Test"
        self-value="radio-test-1"
      />
      <UiRadio
        v-model="radioModel"
        name="test"
        label="Test"
        self-value="radio-test-2"
      />
      <UiRadio
        v-model="radioModel"
        name="test"
        label="Test"
        self-value="radio-test-3"
        disabled
      />
    </div>

    <div class="flex items-center gap-8">
      Health score
      <UiFootnote
        title="Your health score"
        text="Health score measures how safe your position is. A score above 1 means you're safe; below 1 means you're at risk of liquidation."
      />
    </div>
  </section>
</template>
