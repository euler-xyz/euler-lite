# Announcement Modal

Lite can show a one-time, deployment-controlled announcement after onboarding. It is intended for operational notices such as migrations, feature launches, temporary warnings, or links to external announcement posts.

## Files at a Glance

| File | Purpose |
|------|---------|
| `utils/announcement-config.ts` | Normalizes env input, parses list items, validates links, and builds the dismissal token. |
| `server/plugins/app-config.ts` | Reads runtime env vars and injects the announcement into `window.__APP_CONFIG__`. |
| `composables/useEnvConfig.ts` | Resolves injected runtime config first, then Nuxt public runtime config fallbacks. |
| `composables/useDeployConfig.ts` | Exposes `announcement` with other deployment config. |
| `app.vue` | Decides when to open the modal and persists the seen token. |
| `components/entities/announcement/AnnouncementModal.vue` | Renders title, body, bullet list, optional link, and the required acknowledgement button. |

## Configuration

Set any content field to enable the modal. Short names are read at server startup for Doppler/runtime injection; `NUXT_PUBLIC_` names are build-time fallbacks for static deployments.

| Runtime env var | Build-time fallback | Notes |
|---|---|---|
| `CONFIG_ANNOUNCEMENT_TITLE` | `NUXT_PUBLIC_CONFIG_ANNOUNCEMENT_TITLE` | Modal title. Defaults to `Announcement` only if omitted. |
| `CONFIG_ANNOUNCEMENT_BODY` | `NUXT_PUBLIC_CONFIG_ANNOUNCEMENT_BODY` | Paragraph text. Trimmed. |
| `CONFIG_ANNOUNCEMENT_ITEMS` | `NUXT_PUBLIC_CONFIG_ANNOUNCEMENT_ITEMS` | Either newline-delimited text or a JSON string array. Empty items are removed. |
| `CONFIG_ANNOUNCEMENT_URL` | `NUXT_PUBLIC_CONFIG_ANNOUNCEMENT_URL` | Optional "Read the full announcement" link. See URL rules below. |

Example:

```bash
CONFIG_ANNOUNCEMENT_TITLE="Migrate legacy positions"
CONFIG_ANNOUNCEMENT_BODY="Some legacy vault positions can now be moved into newer markets."
CONFIG_ANNOUNCEMENT_ITEMS=$'Review the Portfolio Migrate tab\nTransactions are simulated before submission'
CONFIG_ANNOUNCEMENT_URL="/portfolio"
```

JSON array items are also accepted:

```bash
CONFIG_ANNOUNCEMENT_ITEMS='["Review eligible positions","Simulate before submitting"]'
```

## Display and Dismissal Flow

1. `buildAnnouncementConfig()` trims every field and enables the modal when `title`, `body`, `items`, or a valid `url` is non-empty.
2. `server/plugins/app-config.ts` embeds the normalized config into the HTML as `window.__APP_CONFIG__`.
3. `app.vue` waits until onboarding is complete and the current route is not `/onboarding`.
4. The modal opens as non-closable; the user must press **Got it**.
5. On close, Lite stores the config token in `localStorage["announcement-seen-token"]`.

The token is a JSON serialization of the normalized title, body, items, and URL. Any content change produces a new token, so edited copy or a new link will show the modal again to users who dismissed the previous version. Clearing all content fields disables the modal.

## URL Safety Rules

`CONFIG_ANNOUNCEMENT_URL` is optional and sanitized before it can render:

- Allowed: `https://...`, `http://...`, and root-relative paths such as `/portfolio/migrate`.
- Rejected: `javascript:`, `data:`, plain relative strings like `docs`, protocol-relative URLs such as `//example.com`, and backslash-prefixed root paths such as `/\evil.com`.

If the URL is rejected and no other content is configured, the announcement is disabled. Links render with `target="_blank"` and `rel="noopener noreferrer"`.

## Operational Notes

- Use the short `CONFIG_ANNOUNCEMENT_*` names for deployments where Doppler or another secret manager injects env vars at container startup. They do not require a rebuild because `server/plugins/app-config.ts` reads them when Nitro starts.
- Use `NUXT_PUBLIC_CONFIG_ANNOUNCEMENT_*` only when the app is built as static assets or when build-time public runtime config is the intended source.
- To retire an announcement, unset all four content vars and restart/redeploy the server.
- To force the current announcement to reappear in a browser during local testing, clear `localStorage["announcement-seen-token"]`.

## Troubleshooting

| Symptom | Check |
|---|---|
| Modal does not show | Verify at least one normalized content field is non-empty and onboarding has completed. The modal is suppressed on `/onboarding`. |
| Link is missing | Check the URL against the safety rules above. Rejected URLs are normalized to an empty string. |
| Users do not see updated copy | Confirm the runtime environment changed and the server restarted/redeployed so `window.__APP_CONFIG__` contains the new token. |
| Modal keeps reappearing | The token changes whenever normalized content changes. Check for environment drift between replicas. |
