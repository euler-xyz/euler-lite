/**
 * Escapes a JSON string for safe embedding inside an inline `<script>` tag.
 *
 * JSON.stringify does not escape `<`, so a config value containing `</script>`
 * would break out of the inline script context. Escaping `<` (and the U+2028 /
 * U+2029 line separators, which are invalid in JS string literals) as unicode
 * escapes keeps the payload inside the script tag while preserving identical
 * JSON/JS semantics — `<` parses back to `<` inside string values.
 *
 * Shared by every `window.__*__` injection (see `server/plugins/app-config.ts`
 * and `server/plugins/chain-config.ts`) so the escaping invariant holds for all
 * of them, including payloads that only carry non-string values today.
 */
export function escapeScriptJson(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
