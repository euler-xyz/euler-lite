interface SubmissionCompletionScope {
  markSucceeded(): void
  suppressPostTxUi(): boolean
}

/**
 * Apply confirmed state effects before consulting modal/navigation lifetime.
 * Detachment suppresses only presentation effects, never authoritative state.
 */
export const finalizeSuccessfulSubmission = async ({
  scope,
  completeAuthoritativeState,
  showSuccessUi,
}: {
  scope: SubmissionCompletionScope
  completeAuthoritativeState(): void | Promise<void>
  showSuccessUi(): void | Promise<void>
}): Promise<boolean> => {
  await completeAuthoritativeState()
  scope.markSucceeded()
  const showPostTxUi = !scope.suppressPostTxUi()
  if (showPostTxUi) await showSuccessUi()
  return showPostTxUi
}
