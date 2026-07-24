/**
 * Returns `value` when it is an absolute `http:`/`https:` URL, otherwise
 * `undefined`.
 *
 * For URLs that reach a `:href` or `:src` binding from outside the app —
 * reward provider APIs, token lists, oracle metadata. Vue binds these straight
 * through `setAttribute` with no scheme filtering, so a `javascript:` or
 * `data:text/html` value from a compromised upstream would be live on click.
 * The CSP blocks that today; this keeps the guarantee even if the policy
 * changes or the app is ever served as a static build without one.
 */
export const safeExternalHttpUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:' ? value : undefined
  }
  catch {
    return undefined
  }
}
