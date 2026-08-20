import type { SubmissionState } from '../domain/submission-attempt'

const TRANSITIONS: Readonly<Record<SubmissionState, readonly SubmissionState[]>> = {
  'accepted': ['reserved', 'safely-rejected-before-dispatch', 'expired'],
  'reserved': ['revalidating', 'safely-rejected-before-dispatch', 'expired', 'recovery-required'],
  'revalidating': ['revalidating', 'signing', 'finalized', 'safely-rejected-before-dispatch', 'expired', 'recovery-required'],
  'signing': ['revalidating', 'signing', 'finalized', 'safely-rejected-before-dispatch', 'expired', 'recovery-required'],
  'finalized': ['revalidating', 'dispatching', 'safely-rejected-before-dispatch', 'expired', 'recovery-required'],
  'dispatching': ['dispatching', 'identified', 'confirming', 'safely-rejected-before-dispatch', 'reverted', 'recovery-required'],
  'identified': ['dispatching', 'identified', 'confirming', 'succeeded', 'reverted', 'cancelled-proven', 'cleanup-required', 'recovery-required'],
  'confirming': ['dispatching', 'identified', 'confirming', 'succeeded', 'reverted', 'cancelled-proven', 'cleanup-required', 'recovery-required'],
  'succeeded': [],
  'safely-rejected-before-dispatch': [],
  'reverted': [],
  'cancelled-proven': [],
  'expired': [],
  'cleanup-required': ['cleanup-required', 'succeeded', 'recovery-required'],
  'recovery-required': ['identified', 'confirming', 'succeeded', 'reverted', 'cancelled-proven', 'cleanup-required', 'recovery-required'],
}

export const assertAttemptTransition = (from: SubmissionState, to: SubmissionState) => {
  if (!TRANSITIONS[from].includes(to)) throw new Error(`Attempt transition ${from} -> ${to} is not allowed`)
}
