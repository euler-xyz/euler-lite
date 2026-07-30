<script setup lang="ts">
import { useDebounceFn } from '@vueuse/core'

const {
  view,
  query,
  email,
  article,
  lastReference,
  results,
  isSearching,
  isSending,
  error,
  close,
  goHome,
  searchDocs,
  openArticle,
  send,
} = useSupportPanel()

const { discordUrl, telegramUrl } = useDeployConfig()

const subject = ref('')
const messageBody = ref('')
const emailInput = ref(email.value)
const attachments = ref<File[]>([])
const fileInput = ref<HTMLInputElement>()

const debouncedSearch = useDebounceFn(searchDocs, 250)
watch(query, () => debouncedSearch())

const hasQuery = computed(() => query.value.trim().length >= 2)
const showBack = computed(() => view.value === 'article' || view.value === 'compose')
const backLabel = computed(() =>
  view.value === 'article' ? 'All articles' : 'New conversation',
)

const resultLabel = computed(() => {
  if (isSearching.value) return 'Searching'
  return results.value.length === 1 ? '1 result' : results.value.length + ' results'
})

const canSend = computed(() =>
  !!subject.value.trim() && !!messageBody.value.trim() && /.+@.+\..+/.test(emailInput.value),
)

const onPickFiles = () => fileInput.value?.click()
const onFilesChosen = (event: Event) => {
  const list = (event.target as HTMLInputElement).files
  if (list) attachments.value = [...attachments.value, ...Array.from(list)]
}
const removeAttachment = (index: number) => {
  attachments.value = attachments.value.filter((_, i) => i !== index)
}

const onSend = () => send({
  subject: subject.value,
  body: messageBody.value,
  email: emailInput.value,
  attachments: attachments.value,
})

const fileExtension = (name: string) => name.split('.').pop() ?? 'file'
const fileSizeKb = (size: number) => Math.max(1, Math.round(size / 1024))
</script>

<template>
  <div class="flex flex-col w-[400px] h-[540px] mobile:w-full mobile:h-full bg-card border border-line-default rounded-16 shadow-xl overflow-hidden">
    <!-- Header -->
    <div class="flex flex-shrink-0 items-center gap-10 py-13 pr-14 pl-16 bg-surface-elevated border-b border-line-default">
      <LogoBrand class="!w-18 !h-18 text-accent-500" />
      <div class="flex-1 min-w-0">
        <p class="text-[13px] font-semibold leading-tight text-content-primary">
          Support
        </p>
        <p class="text-[11px] leading-tight text-content-muted">
          Replies by email, usually within 4 hours
        </p>
      </div>
      <UiButton
        variant="secondary-ghost"
        size="small"
        icon="close"
        icon-only
        aria-label="Close support"
        @click="close"
      />
    </div>

    <!-- Back row -->
    <button
      v-if="showBack"
      class="flex flex-shrink-0 items-center gap-8 w-full py-9 px-16 text-left text-[12px] font-medium text-content-secondary border-b border-line-default hover:bg-card-hover hover:text-content-primary transition-colors"
      @click="goHome"
    >
      <SvgIcon
        class="!w-14 !h-14 text-content-muted"
        name="arrow-left"
      />
      <span class="truncate">{{ backLabel }}</span>
    </button>

    <!-- Body -->
    <div class="flex-1 min-h-0 overflow-y-auto">
      <!-- Home -->
      <template v-if="view === 'home'">
        <div class="pt-14 px-16">
          <UiInput
            v-model="query"
            icon="search"
            placeholder="Search help articles"
          />
        </div>

        <template v-if="hasQuery">
          <p class="pt-16 pb-8 px-16 text-[10px] font-medium uppercase tracking-[0.08em] text-content-muted">
            {{ resultLabel }}
          </p>
          <div class="flex flex-col px-8 pb-12">
            <button
              v-for="item in results"
              :key="item.id"
              class="flex items-start gap-10 w-full p-10 text-left rounded-8 hover:bg-card-hover transition-colors"
              @click="openArticle(item)"
            >
              <span class="flex-1 min-w-0">
                <span class="block text-[13px] font-medium leading-snug text-content-primary">{{ item.name }}</span>
                <span class="block mt-3 text-[11.5px] leading-snug text-content-tertiary">{{ item.preview }}</span>
              </span>
              <SvgIcon
                class="!w-14 !h-14 mt-3 rotate-180 text-content-muted"
                name="arrow-left"
              />
            </button>
          </div>
          <div
            v-if="!isSearching && !results.length"
            class="mx-16 mb-16 p-16 text-center border border-dashed border-line-emphasis rounded-12"
          >
            <p class="text-[12.5px] leading-normal text-content-secondary">
              Nothing matched that. Ask us directly — we read every message.
            </p>
          </div>
        </template>
      </template>

      <!-- Article -->
      <div
        v-else-if="view === 'article' && article"
        class="p-16"
      >
        <p
          v-if="article.collection"
          class="text-[10px] font-medium uppercase tracking-[0.08em] text-content-accent"
        >
          {{ article.collection }}
        </p>
        <h2 class="mt-8 text-[21px] font-light leading-tight tracking-[-0.02em] text-content-primary">
          {{ article.name }}
        </h2>
        <!-- Article HTML comes from our own HelpScout Docs collection, fetched
             server-side and authored by the support team — not user input. -->
        <!-- eslint-disable vue/no-v-html -->
        <div
          class="support-article mt-14 text-[13px] leading-relaxed text-content-secondary"
          v-html="article.text ?? article.preview"
        />
        <!-- eslint-enable vue/no-v-html -->
      </div>

      <!-- Compose -->
      <div
        v-else-if="view === 'compose'"
        class="flex flex-col gap-12 p-16"
      >
        <div>
          <label
            class="block mb-6 text-[11.5px] font-medium text-content-tertiary"
            for="support-subject"
          >Subject</label>
          <UiInput
            id="support-subject"
            v-model="subject"
            placeholder="Short summary of the issue"
          />
        </div>

        <div>
          <label
            class="block mb-6 text-[11.5px] font-medium text-content-tertiary"
            for="support-body"
          >Message</label>
          <div class="flex bg-surface border border-line-emphasis rounded-8 shadow-input focus-within:border-accent-500 focus-within:shadow-input-focus transition-all">
            <textarea
              id="support-body"
              v-model="messageBody"
              class="w-full h-[112px] py-10 px-14 bg-transparent text-[13px] leading-normal text-content-primary outline-none resize-none"
              placeholder="What happened, what you expected, and the transaction hash if you have one."
            />
          </div>
        </div>

        <div>
          <label
            class="block mb-6 text-[11.5px] font-medium text-content-tertiary"
            for="support-email"
          >Email for the reply</label>
          <UiInput
            id="support-email"
            v-model="emailInput"
            type="email"
            autocomplete="email"
            placeholder="you@example.com"
          />
        </div>

        <div class="flex flex-col gap-8">
          <div
            v-for="(file, index) in attachments"
            :key="file.name + index"
            class="flex items-center gap-10 py-8 px-10 bg-card border border-line-default rounded-8"
          >
            <span class="flex items-center justify-center w-26 h-26 flex-shrink-0 bg-surface-elevated rounded-[6px] text-[9px] font-semibold uppercase text-content-tertiary">
              {{ fileExtension(file.name) }}
            </span>
            <span class="flex-1 min-w-0 truncate text-[12px] text-content-secondary">{{ file.name }}</span>
            <span class="text-[11px] text-content-muted tabular-nums">{{ fileSizeKb(file.size) }} KB</span>
            <button
              class="flex items-center justify-center w-22 h-22 rounded-[6px] text-content-muted hover:bg-card-hover hover:text-content-primary transition-colors"
              aria-label="Remove attachment"
              @click="removeAttachment(index)"
            >
              <SvgIcon
                class="!w-12 !h-12"
                name="close"
              />
            </button>
          </div>
          <button
            class="flex items-center justify-center gap-6 w-full p-8 border border-dashed border-line-emphasis rounded-8 text-[12px] font-medium text-content-tertiary hover:text-content-primary hover:border-accent-500 transition-colors"
            @click="onPickFiles"
          >
            <SvgIcon
              class="!w-14 !h-14"
              name="plus"
            />
            <span>Add attachment</span>
          </button>
          <input
            ref="fileInput"
            class="hidden"
            type="file"
            multiple
            @change="onFilesChosen"
          >
        </div>

        <div class="flex items-start gap-7 text-content-muted">
          <SvgIcon
            class="!w-13 !h-13 mt-1 flex-shrink-0"
            name="info-circle"
          />
          <span class="text-[11px] leading-snug">Wallet, chain and recent console logs are attached.</span>
        </div>

        <UiAlert
          v-if="error"
          variant="error"
          :title="error"
        />
      </div>

      <!-- Sent -->
      <div
        v-else-if="view === 'sent'"
        class="flex flex-col items-center justify-center h-full px-32 pt-32 pb-24 text-center"
      >
        <div class="flex items-center justify-center w-52 h-52 rounded-full bg-accent-100 text-accent-500">
          <SvgIcon
            class="!w-24 !h-24"
            name="check"
          />
        </div>
        <p class="mt-16 text-[22px] font-light tracking-[-0.02em] text-content-primary">
          Message sent
        </p>
        <p class="mt-8 text-[12.5px] leading-relaxed text-content-tertiary">
          We reply by email, usually within 4 hours.
        </p>
        <div
          v-if="lastReference"
          class="flex items-center gap-8 mt-18 py-7 px-12 bg-card border border-line-default rounded-full"
        >
          <span class="text-[11px] text-content-muted">Reference</span>
          <span class="text-[11.5px] font-medium text-content-primary tabular-nums">{{ lastReference }}</span>
        </div>
      </div>
    </div>

    <!-- Footers -->
    <div
      v-if="view === 'home'"
      class="flex flex-col gap-10 flex-shrink-0 py-12 px-16 bg-surface-elevated border-t border-line-default"
    >
      <UiButton
        variant="primary"
        size="large"
        rounded
        @click="view = 'compose'"
      >
        Start a conversation
      </UiButton>
      <div class="flex items-center gap-8">
        <span class="flex-1 text-[10.5px] text-content-muted">Prefer the community?</span>
        <a
          v-if="discordUrl"
          class="flex items-center gap-5 py-4 px-9 bg-card border border-line-default rounded-full text-[11px] font-medium text-content-tertiary no-underline hover:text-content-primary hover:bg-card-hover transition-colors"
          :href="discordUrl"
          target="_blank"
          rel="noopener noreferrer"
        >
          <SvgIcon
            class="!w-13 !h-13"
            name="discord"
          />
          <span>Discord</span>
        </a>
        <a
          v-if="telegramUrl"
          class="flex items-center gap-5 py-4 px-9 bg-card border border-line-default rounded-full text-[11px] font-medium text-content-tertiary no-underline hover:text-content-primary hover:bg-card-hover transition-colors"
          :href="telegramUrl"
          target="_blank"
          rel="noopener noreferrer"
        >
          <SvgIcon
            class="!w-13 !h-13"
            name="telegram"
          />
          <span>Telegram</span>
        </a>
      </div>
    </div>

    <div
      v-else-if="view === 'article'"
      class="flex items-center gap-10 flex-shrink-0 py-12 px-16 bg-surface-elevated border-t border-line-default"
    >
      <span class="flex-1 text-[12px] text-content-tertiary">Still stuck?</span>
      <UiButton
        variant="primary"
        size="medium"
        @click="view = 'compose'"
      >
        Start a conversation
      </UiButton>
    </div>

    <div
      v-else-if="view === 'compose'"
      class="flex items-center gap-12 flex-shrink-0 py-12 px-16 bg-surface-elevated border-t border-line-default"
    >
      <span class="flex-1 text-[10.5px] leading-snug text-content-muted">Answered in ~4 hours, Mon–Fri</span>
      <UiButton
        variant="primary"
        size="medium"
        :disabled="!canSend"
        :loading="isSending"
        @click="onSend"
      >
        Send message
      </UiButton>
    </div>

    <div
      v-else-if="view === 'sent'"
      class="flex flex-shrink-0 py-12 px-16 bg-surface-elevated border-t border-line-default"
    >
      <UiButton
        class="flex-1"
        variant="secondary"
        size="medium"
        @click="goHome"
      >
        Back to help
      </UiButton>
    </div>
  </div>
</template>

<style scoped>
.support-article :deep(p) {
  margin: 0 0 12px;
}

.support-article :deep(p:last-child) {
  margin-bottom: 0;
}

.support-article :deep(a) {
  color: var(--text-accent);
}

.support-article :deep(ul),
.support-article :deep(ol) {
  margin: 0 0 12px;
  padding-left: 20px;
}

.support-article :deep(code) {
  padding: 1px 4px;
  background: var(--bg-surface-elevated);
  border-radius: 4px;
  font-size: 12px;
}
</style>
