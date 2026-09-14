/**
 * Escape serialized JSON before embedding it in an inline script element.
 * JSON.stringify does not escape `<`, so an env-derived value could otherwise
 * terminate the script element. U+2028/U+2029 are escaped for JS compatibility.
 */
export function escapeScriptJson(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
