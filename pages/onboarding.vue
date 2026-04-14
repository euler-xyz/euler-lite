<script setup lang="ts">
import { useAccount } from '@wagmi/vue'
import { getDefaultPageRoute } from '~/entities/menu'

const { isConnected } = useAccount()

const { connect } = useWagmi()
const {
  appTitle,
  appDescription,
  enableEarnPage,
  enableLendPage,
  enableExplorePage,
} = useDeployConfig()
const defaultPageRoute = getDefaultPageRoute(
  enableEarnPage,
  enableLendPage,
  enableExplorePage,
)

const isOnboardingCompleted = useLocalStorage('is-onboarding-completed', false)

const onConnectWalletClick = () => {
  connect()
}

const onConnectLaterClick = () => {
  isOnboardingCompleted.value = true
  navigateTo({ name: defaultPageRoute })
}

watch(
  isConnected,
  (value) => {
    if (value) {
      isOnboardingCompleted.value = true
      navigateTo({ name: defaultPageRoute })
    }
  },
  { immediate: true },
)
</script>

<template>
  <section class="w-full h-dvh -mt-16 -mb-[98px]">
    <div
      class="relative flex flex-col items-center justify-between gap-24 h-full pb-64 mobile:-mx-16"
    >
      <div class="flex-1 w-full h-full -z-10 overflow-hidden">
        <svg
          class="w-full h-full text-accent-400"
          viewBox="0 0 750.000000 826.000000"
          preserveAspectRatio="xMidYMax slice"
          xmlns="http://www.w3.org/2000/svg"
        >
          <g
            transform="translate(0.000000,826.000000) scale(0.100000,-0.100000)"
            fill="currentColor"
            stroke="none"
          >
            <path
              d="M1968 8173 c-451 -339 -787 -773 -991 -1283 -125 -312 -187 -591 -209 -942 l-12 -188 -378 0 c-245 0 -378 -4 -378 -10 0 -6 133 -10 379 -10 l379 0 7 -102 c23 -358 90 -663 209 -960 390 -974 1255 -1668 2287 -1838 68 -11 204 -26 302 -32 l177 -12 0 -1228 0 -1228 -107 0 c-224 0 -586 36 -853 84 -998 179 -1902 620 -2664 1298 -61 54 -112 95 -115 92 -12 -13 272 -257 474 -407 799 -597 1711 -951 2725 -1060 19 -2 -693 -5 -1582 -5 -1071 -1 -1618 -5 -1618 -12 0 -7 1257 -10 3750 -10 2493 0 3750 3 3750 10 0 7 -550 10 -1627 11 -949 1 -1597 5 -1553 10 1173 133 2229 608 3093 1392 48 43 87 84 87 89 0 6 -28 -15 -62 -46 -128 -115 -317 -271 -443 -366 -884 -662 -1953 -1039 -3052 -1077 l-183 -6 0 1230 0 1230 113 7 c453 28 845 132 1226 326 835 426 1431 1244 1581 2171 17 106 40 345 40 417 l0 22 390 0 c253 0 390 4 390 10 0 6 -136 10 -389 10 l-388 0 -7 138 c-40 773 -339 1455 -871 1987 -159 159 -438 382 -466 373 -6 -2 16 -21 47 -43 184 -126 426 -347 576 -525 424 -504 668 -1128 695 -1772 l6 -158 -1471 0 -1472 0 0 1250 c0 827 -3 1250 -10 1250 -7 0 -10 -423 -10 -1250 l0 -1250 -1480 0 -1480 0 0 88 c0 180 37 452 90 662 102 400 293 786 552 1112 158 199 386 417 588 561 105 74 108 77 89 77 -8 0 -67 -39 -131 -87z m1772 -3893 l0 -1460 -78 0 c-170 0 -447 38 -652 90 -223 57 -406 126 -624 238 -928 474 -1547 1426 -1602 2465 l-7 127 1481 0 1482 0 0 -1460z m2960 1402 c0 -150 -41 -437 -90 -632 -57 -223 -126 -406 -238 -624 -476 -932 -1435 -1553 -2475 -1603 l-137 -6 0 1461 0 1462 1470 0 1470 0 0 -58z"
            />
          </g>
        </svg>
      </div>
      <div class="flex flex-col items-center gap-24 w-full px-16">
        <LogoBrand class="!w-[75px] !h-[75px] text-accent-600" />
        <div class="text-h1 text-center w-[240px]">
          {{ appTitle }}
        </div>
        <div class="text-content-primary text-center">
          {{ appDescription }}
        </div>
        <div class="flex flex-col gap-8 w-full">
          <UiButton
            size="large"
            rounded
            @click="onConnectWalletClick"
          >
            Connect wallet
          </UiButton>
          <UiButton
            size="large"
            rounded
            variant="secondary"
            @click="onConnectLaterClick"
          >
            Connect later
          </UiButton>
        </div>
      </div>
    </div>
  </section>
</template>
