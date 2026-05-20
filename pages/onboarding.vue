<script setup lang="ts">
import { getDefaultPageRoute } from '~/entities/menu'

const { isConnected } = useWagmi()

const { connect } = useWagmi()
const {
  appTitle,
  appDescription,
  enableEarnPage,
  enableLendPage,
  enableExplorePage,
  docsUrl,
  tosUrl,
  privacyPolicyUrl,
  riskDisclosuresUrl,
  xUrl,
  discordUrl,
  githubUrl,
  telegramUrl,
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

const legalLinks = computed(() =>
  [
    tosUrl ? { title: 'Terms', url: tosUrl } : null,
    privacyPolicyUrl ? { title: 'Privacy', url: privacyPolicyUrl } : null,
    riskDisclosuresUrl ? { title: 'Risk disclosures', url: riskDisclosuresUrl } : null,
    docsUrl ? { title: 'Docs', url: docsUrl } : null,
  ].filter(Boolean) as Array<{ title: string, url: string }>,
)

const socialLinks = computed(() =>
  [
    xUrl ? { name: 'x', url: xUrl } : null,
    githubUrl ? { name: 'github', url: githubUrl } : null,
    discordUrl ? { name: 'discord', url: discordUrl } : null,
    telegramUrl ? { name: 'telegram', url: telegramUrl } : null,
  ].filter(Boolean) as Array<{ name: string, url: string }>,
)
</script>

<template>
  <section class="onboarding">
    <!-- Grid backdrop -->
    <div class="onboarding__backdrop">
      <div class="onboarding__grid" />
      <div class="onboarding__glow" />
    </div>

    <!-- Centered content -->
    <div class="onboarding__center">
      <div
        class="onboarding__logo-container onboarding__rise"
        style="--delay: 0ms"
      >
        <LogoBrand class="!w-42 !h-42 text-accent-500" />
      </div>

      <h1
        class="onboarding__title onboarding__rise"
        style="--delay: 80ms"
      >
        Welcome to <span class="text-accent-500">{{ appTitle }}</span>
      </h1>

      <p
        class="onboarding__description onboarding__rise"
        style="--delay: 160ms"
      >
        {{ appDescription || 'Connect a wallet to get started, or take a look around first.' }}
      </p>

      <div
        class="onboarding__actions onboarding__rise"
        style="--delay: 240ms"
      >
        <UiButton
          size="xlarge"
          rounded
          icon="plus"
          @click="onConnectWalletClick"
        >
          Connect wallet
        </UiButton>
        <UiButton
          size="xlarge"
          rounded
          variant="secondary"
          @click="onConnectLaterClick"
        >
          Connect later
        </UiButton>
      </div>
    </div>

    <!-- Bottom-left: Legal links -->
    <div
      v-if="legalLinks.length"
      class="onboarding__corner-legal"
    >
      <a
        v-for="link in legalLinks"
        :key="link.title"
        :href="link.url"
        target="_blank"
        rel="noopener noreferrer"
        class="onboarding__legal-link"
      >
        {{ link.title }}
      </a>
    </div>

    <!-- Bottom-right: Social icons -->
    <div
      v-if="socialLinks.length"
      class="onboarding__corner-socials"
    >
      <a
        v-for="item in socialLinks"
        :key="item.name"
        :href="item.url"
        :aria-label="item.name"
        target="_blank"
        rel="noopener noreferrer"
        class="onboarding__social-link"
      >
        <SvgIcon
          class="!w-14 !h-14"
          :name="item.name"
        />
      </a>
    </div>
  </section>
</template>

<style lang="scss" scoped>
$mono-stack: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;

@keyframes onboarding-rise {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.onboarding {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: var(--bg-body);
  overflow: hidden;

  &__backdrop {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
  }

  &__grid {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(to right, var(--border-subtle) 1px, transparent 1px),
      linear-gradient(to bottom, var(--border-subtle) 1px, transparent 1px);
    background-size: 64px 64px;
    mask-image: radial-gradient(circle at center, black 0%, transparent 75%);
    -webkit-mask-image: radial-gradient(circle at center, black 0%, transparent 75%);
  }

  &__glow {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 600px;
    height: 600px;
    border-radius: 50%;
    background: radial-gradient(
      circle,
      rgba(var(--accent-rgb), 0.18) 0%,
      rgba(var(--accent-rgb), 0) 70%
    );
  }

  &__center {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 24px;
    text-align: center;
  }

  &__rise {
    animation: onboarding-rise 600ms cubic-bezier(0.2, 0.7, 0.2, 1) var(--delay, 0ms) both;
  }

  &__logo-container {
    width: 88px;
    height: 88px;
    border-radius: 22px;
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow:
      0 10px 30px -12px rgba(var(--accent-rgb), 0.35),
      0 2px 6px rgba(0, 0, 0, 0.04);
  }

  &__title {
    margin: 36px 0 0;
    font-family: 'Plus Jakarta Sans', sans-serif;
    font-size: clamp(48px, 5vw, 68px);
    font-weight: 300;
    letter-spacing: -0.035em;
    line-height: 1.02;
    color: var(--text-primary);
  }

  &__description {
    margin: 20px 0 0;
    max-width: 520px;
    font-family: 'Plus Jakarta Sans', sans-serif;
    font-size: 17px;
    font-weight: 300;
    line-height: 1.5;
    color: var(--text-tertiary);
  }

  &__actions {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 360px;
    max-width: 100%;
    margin-top: 40px;
  }

  &__corner-legal {
    position: absolute;
    bottom: 24px;
    left: 32px;
    z-index: 2;
    display: flex;
    gap: 18px;
    align-items: center;
    font-size: 11px;
    font-family: $mono-stack;
    letter-spacing: 0.04em;
  }

  &__legal-link {
    color: var(--text-muted);
    text-decoration: none;
    transition: color var(--duration-fast) ease;

    &:hover {
      color: var(--text-tertiary);
    }
  }

  &__corner-socials {
    position: absolute;
    bottom: 24px;
    right: 32px;
    z-index: 2;
    display: flex;
    gap: 8px;
  }

  &__social-link {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-tertiary);
    border: 1px solid var(--border-default);
    background: var(--bg-surface);
    transition: color var(--duration-fast) ease, border-color var(--duration-fast) ease;

    &:hover {
      color: var(--accent-500);
      border-color: var(--accent-500);
    }
  }
}

@media (max-width: 900px) {
  .onboarding {
    &__title {
      font-size: clamp(36px, 8vw, 48px);
    }

    &__corner-legal {
      bottom: 16px;
      left: 0;
      right: 0;
      justify-content: center;
      gap: 12px;
      font-size: 10px;
    }

    &__corner-socials {
      bottom: 46px;
      left: 0;
      right: 0;
      justify-content: center;
    }
  }
}
</style>
