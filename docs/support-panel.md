# In-app support panel

An in-app support panel built from the app's own components, tokens and theme.
HelpScout stays the backend — Docs API for article search, Mailbox API v2 for
creating the ticket — but every HelpScout call is made **server-side**, so the
browser never talks to HelpScout and no CSP entries are needed for it.

Opens from `Support`, the first entry in the header's Resources dropdown.

## Configuration

The panel is always mounted — there is no feature flag. It needs these
server-side credentials to do anything useful:

```
HELPSCOUT_DOCS_API_KEY=…            # Docs API key (Basic auth, key as username)
HELPSCOUT_DOCS_COLLECTION_ID=…      # optional: scope search to one collection
HELPSCOUT_APP_ID=…                  # Mailbox API v2 OAuth2 client id
HELPSCOUT_APP_SECRET=…
HELPSCOUT_MAILBOX_ID=…              # mailbox new conversations land in
```

Until they are set the panel opens and behaves normally, but article search
returns 503 and sending shows "The message could not be sent" — the guards in
`docs.get.ts` and `conversations.post.ts` fail cleanly rather than calling
HelpScout with empty credentials.

**The HelpScout Beacon bubble is therefore still loaded and visible**, because it
is the channel that actually delivers tickets today. Once the credentials above
are in place, retire the bubble by adding
`document.documentElement.classList.add('beacon-hidden')` in `app.vue` (the CSS
rule already exists in `assets/styles/main.scss`), and then remove the Beacon
loader from `nuxt.config.ts`, its `*.helpscout.net` /
`sockjs-helpscout.pusher.com` entries from `server/plugins/csp.ts`, the
`window.Beacon` type in `types/index.ts`, and update the Beacon assertion in
`tests/server/security.test.ts`.

## Files

```
composables/useSupportPanel.ts               shared state + data access
components/support/SupportPanel.vue          the panel itself
components/support/SupportPanelHost.vue      teleported host, outside-click / Esc
server/utils/helpscout.ts                    Docs + Mailbox clients, token cache
server/api/internal/support/docs.get.ts      article search / read
server/api/internal/support/conversations.post.ts   create the conversation
```

## Diagnostics

`utils/console-capture.ts` (installed at boot by
`plugins/00.console-capture.client.ts`) keeps a ring buffer of recent console
output with query-string values redacted. On send, the wallet address, chain id,
user agent and that buffer are posted as an **internal note** on the
conversation, so they are visible to agents but never in the customer-facing
thread. The compose form states this above the send button.

## Deliberate scope limits

- **Browse + compose only.** Reading past conversations is not implemented.
  HelpScout keys conversations by customer email, so a "your conversations" view
  needs an email-authorized read endpoint — and anyone who knew an address could
  then read that user's support history. Adding it is a product/privacy decision;
  see the GDPR notes below.
- **The email is not an identity.** It is collected so HelpScout can reply, and
  remembered in `localStorage` only to prefill the field next time. Nothing is
  read back from HelpScout using it.
- **No live chat.** Beacon's chat runs over its own socket with no public API.
  The panel is ticket-first, matching the ~4h email SLA.

## GDPR notes

Sending a ticket links a wallet address to an email address in HelpScout, which
is the linkage that deanonymizes an otherwise pseudonymous wallet. Before
enabling this in production:

- name the lawful basis (legitimate interest for support is the natural fit) and
  document the assessment;
- disclose in the privacy policy that support requests include the connected
  wallet address, diagnostics, and that HelpScout Inc. processes them;
- confirm the HelpScout DPA and transfer basis;
- make sure the DSAR/erasure process covers HelpScout.

## Untested against a live account

The Docs API v1 and Mailbox API v2 request/response shapes here follow the
published documentation but have not been exercised against a real HelpScout
account. Verify field names — in particular the `Resource-ID` header on
conversation create and the `number` field used for the `EUL-<n>` reference —
before relying on them.
