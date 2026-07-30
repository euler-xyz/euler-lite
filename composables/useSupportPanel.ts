import { getRecentConsoleOutput } from '~/utils/console-capture'

export type SupportView = 'home' | 'article' | 'compose' | 'sent'

export interface SupportArticle {
  id: string
  name: string
  preview: string
  collection?: string
  text?: string
}

/**
 * Shared state + data access for the in-app support panel.
 *
 * HelpScout stays the backend (Docs API for article search, Mailbox API for
 * creating the conversation) but every call is server-side via
 * /api/internal/support/*, so no third-party script runs on the page.
 *
 * State lives in useState so the header menu item, the teleported host and the
 * panel body all read the same open/view state across navigation.
 *
 * Scope note: this ships browse + compose only. Reading past conversations is
 * deliberately absent — HelpScout keys conversations by customer email, and an
 * email-authorized read endpoint would let anyone who knows an address read
 * that user's support history. See docs/support-panel.md.
 */
export const useSupportPanel = () => {
  const isOpen = useState('support-panel-open', () => false)
  const view = useState<SupportView>('support-panel-view', () => 'home')
  const query = useState('support-panel-query', () => '')
  const article = useState<SupportArticle | undefined>('support-panel-article', () => undefined)
  const results = useState<SupportArticle[]>('support-panel-results', () => [])
  const lastReference = useState('support-panel-reference', () => '')
  // Shared, not plain refs: the panel body and the header both instantiate this
  // composable, and a per-instance ref would desync their view of a send.
  const isSearching = useState('support-panel-searching', () => false)
  const isSending = useState('support-panel-sending', () => false)
  const error = useState('support-panel-error', () => '')

  // Remembered only to prefill the compose field on a later visit. It is not an
  // identity: nothing is read back from HelpScout using it.
  const email = useLocalStorage('support-email', '')

  // Resolved during setup — collectDiagnostics() runs from a click handler,
  // where calling a composable would throw "nuxt instance unavailable".
  const { address } = useWagmi()
  const { chainId } = useEulerAddresses()

  const open = (next: SupportView = 'home') => {
    view.value = next
    isOpen.value = true
  }
  const close = () => {
    isOpen.value = false
  }
  const goHome = () => {
    view.value = 'home'
    query.value = ''
    results.value = []
    error.value = ''
  }

  const searchDocs = async () => {
    const term = query.value.trim()
    if (term.length < 2) {
      results.value = []
      return
    }
    isSearching.value = true
    error.value = ''
    try {
      results.value = await $fetch<SupportArticle[]>('/api/internal/support/docs', {
        query: { q: term },
      })
    }
    catch {
      error.value = 'Search is unavailable right now.'
      results.value = []
    }
    finally {
      isSearching.value = false
    }
  }

  const openArticle = async (item: SupportArticle) => {
    article.value = item
    view.value = 'article'
    if (item.text) return
    try {
      const full = await $fetch<SupportArticle>('/api/internal/support/docs', {
        query: { id: item.id },
      })
      article.value = { ...item, ...full }
    }
    catch {
      // The preview copy is already on screen; a failed full fetch is not fatal.
    }
  }

  /** Same diagnostics the Beacon integration attached as session data. */
  const collectDiagnostics = () => ({
    wallet: address.value ?? 'not connected',
    chainId: String(chainId.value),
    userAgent: import.meta.client ? navigator.userAgent : '',
    consoleOutput: getRecentConsoleOutput(),
  })

  const send = async (payload: {
    subject: string
    body: string
    email: string
    attachments?: File[]
  }) => {
    isSending.value = true
    error.value = ''
    try {
      const form = new FormData()
      form.append('subject', payload.subject)
      form.append('body', payload.body)
      form.append('email', payload.email)
      form.append('diagnostics', JSON.stringify(collectDiagnostics()))
      for (const file of payload.attachments ?? []) form.append('attachments', file)

      const created = await $fetch<{ reference: string }>(
        '/api/internal/support/conversations',
        { method: 'POST', body: form },
      )
      email.value = payload.email
      lastReference.value = created.reference
      view.value = 'sent'
    }
    catch {
      error.value = 'The message could not be sent. Try again, or reach us on Discord.'
    }
    finally {
      isSending.value = false
    }
  }

  return {
    isOpen,
    view,
    query,
    email,
    article,
    lastReference,
    results,
    isSearching,
    isSending,
    error,
    open,
    close,
    goHome,
    searchDocs,
    openArticle,
    send,
  }
}
